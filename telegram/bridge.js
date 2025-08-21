// telegram/bridge.js
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import mime from 'mime-types';
import { connectDb } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/utils.js'; // Assuming you have a logger utility

class TelegramBridge {
    constructor() {
        this.instagramBot = null; // Will be set later
        this.telegramBot = null;
        this.chatMappings = new Map(); // instagramThreadId -> telegramTopicId
        this.userMappings = new Map(); // instagramUserId -> { username, fullName, firstSeen, messageCount }
        this.profilePicCache = new Map(); // instagramId (thread/user) -> profilePicUrl
        this.tempDir = path.join(process.cwd(), 'temp');
        this.db = null;
        this.collection = null; // Single 'bridge' collection like WA
        this.telegramChatId = null; // Supergroup ID for forum
        this.creatingTopics = new Map(); // instagramThreadId => Promise
        this.topicVerificationCache = new Map(); // instagramThreadId => boolean (exists)
        this.enabled = false;
        this.filters = new Set(); // Placeholder for filters if needed
    }

    async initialize(instagramBotInstance) {
        this.instagramBot = instagramBotInstance; // Link to the main Instagram bot instance

        const token = config.telegram?.botToken;
        this.telegramChatId = config.telegram?.chatId;

        if (!token || token.includes('YOUR_BOT_TOKEN') || !this.telegramChatId || this.telegramChatId.includes('YOUR_CHAT_ID')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured for Instagram bridge');
            return;
        }

        try {
            await this.initializeDatabase();
            await fs.ensureDir(this.tempDir);
            this.telegramBot = new TelegramBot(token, {
                polling: true,
                // onlyFirstMatch: true // Add if needed
            });

            await this.setupTelegramHandlers();
            await this.loadMappingsFromDb();
            await this.loadFiltersFromDb(); // If you want filters

            // Set up Instagram event listeners now that Telegram is ready
            this.setupInstagramHandlers();

            this.enabled = true;
            logger.info('✅ Instagram-Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Instagram-Telegram bridge:', error.message);
            // Disable bridge on critical init failure
            this.enabled = false;
        }
    }

    async initializeDatabase() {
        try {
            this.db = await connectDb();
            await this.db.command({ ping: 1 });
            logger.info('✅ MongoDB connection successful for Instagram bridge');
            this.collection = this.db.collection('bridge'); // Reuse 'bridge' collection
            // Create indexes similar to TelegramBridge (adjust field names for Instagram)
            await this.collection.createIndex({ type: 1, 'data.instagramThreadId': 1 }, { unique: true, partialFilterExpression: { type: 'chat' } });
            await this.collection.createIndex({ type: 1, 'data.instagramUserId': 1 }, { unique: true, partialFilterExpression: { type: 'user' } });
            // Add index for profile pictures if stored separately (or store within chat mapping)
            logger.info('📊 Database initialized for Instagram bridge (single collection: bridge)');
        } catch (error) {
            logger.error('❌ Failed to initialize database for Instagram bridge:', error.message);
            throw error; // Rethrow to potentially stop bridge init
        }
    }

    async loadMappingsFromDb() {
        if (!this.collection) {
            logger.warn('⚠️ Database collection not available, skipping mapping load');
            return;
        }
        try {
            const mappings = await this.collection.find({}).toArray();
            for (const mapping of mappings) {
                switch (mapping.type) {
                    case 'chat': // Maps Instagram Thread to Telegram Topic
                        this.chatMappings.set(mapping.data.instagramThreadId, mapping.data.telegramTopicId);
                        if (mapping.data.profilePicUrl) {
                            this.profilePicCache.set(mapping.data.instagramThreadId, mapping.data.profilePicUrl);
                        }
                        break;
                    case 'user': // Maps Instagram User ID to Info
                        this.userMappings.set(mapping.data.instagramUserId, {
                            username: mapping.data.username,
                            fullName: mapping.data.fullName,
                            firstSeen: mapping.data.firstSeen,
                            messageCount: mapping.data.messageCount || 0
                        });
                        break;
                }
            }
            logger.info(`📊 Loaded Instagram mappings: ${this.chatMappings.size} chats, ${this.userMappings.size} users`);
        } catch (error) {
            logger.error('❌ Failed to load Instagram mappings:', error.message);
        }
    }

    async saveChatMapping(instagramThreadId, telegramTopicId, profilePicUrl = null) {
        if (!this.collection) return;
        try {
            const updateData = {
                type: 'chat',
                data: {
                    instagramThreadId,
                    telegramTopicId,
                    createdAt: new Date(),
                    lastActivity: new Date()
                }
            };
            if (profilePicUrl) {
                updateData.data.profilePicUrl = profilePicUrl;
            }
            await this.collection.updateOne(
                { type: 'chat', 'data.instagramThreadId': instagramThreadId },
                { $set: updateData },
                { upsert: true }
            );
            this.chatMappings.set(instagramThreadId, telegramTopicId);
            if (profilePicUrl) {
                this.profilePicCache.set(instagramThreadId, profilePicUrl);
            }
            this.topicVerificationCache.delete(instagramThreadId);
            logger.debug(`✅ Saved chat mapping: ${instagramThreadId} -> ${telegramTopicId}${profilePicUrl ? ' (with profile pic)' : ''}`);
        } catch (error) {
            logger.error('❌ Failed to save Instagram chat mapping:', error.message);
        }
    }

    async saveUserMapping(instagramUserId, userData) {
        if (!this.collection) return;
        try {
            await this.collection.updateOne(
                { type: 'user', 'data.instagramUserId': instagramUserId },
                {
                    $set: {
                        type: 'user',
                        data: {
                            instagramUserId,
                            username: userData.username,
                            fullName: userData.fullName,
                            firstSeen: userData.firstSeen,
                            messageCount: userData.messageCount || 0,
                            lastSeen: new Date()
                        }
                    }
                },
                { upsert: true }
            );
            this.userMappings.set(instagramUserId, userData);
            logger.debug(`✅ Saved Instagram user mapping: ${instagramUserId} (@${userData.username || 'unknown'})`);
        } catch (error) {
            logger.error('❌ Failed to save Instagram user mapping:', error.message);
        }
    }

    async updateProfilePicUrl(instagramId, profilePicUrl) { // instagramId can be threadId or userId
        if (!this.collection) return;
        try {
            // Update the chat mapping where instagramId matches threadId
            await this.collection.updateOne(
                { type: 'chat', 'data.instagramThreadId': instagramId },
                { $set: { 'data.profilePicUrl': profilePicUrl, 'data.lastProfilePicUpdate': new Date() } }
            );
            this.profilePicCache.set(instagramId, profilePicUrl);
            logger.debug(`✅ Updated profile pic URL for ${instagramId}: ${profilePicUrl}`);
        } catch (error) {
            logger.debug(`ℹ️ Profile pic update for ${instagramId} (might be user, not chat):`, error.message);
        }
    }

    async loadFiltersFromDb() {
        this.filters = new Set();
        if (!this.collection) return;
        try {
            const filterDocs = await this.collection.find({ type: 'filter' }).toArray();
            for (const doc of filterDocs) {
                this.filters.add(doc.word);
            }
            logger.info(`✅ Loaded ${this.filters.size} filters from DB`);
        } catch (error) {
            logger.error('❌ Failed to load filters:', error.message);
        }
    }

    // --- Topic Management ---

    async getOrCreateTopic(instagramThreadId, senderUserId) {
        // ✅ If topic already cached, return
        if (this.chatMappings.has(instagramThreadId)) {
            return this.chatMappings.get(instagramThreadId);
        }

        // ✅ If another creation is in progress, wait for it
        if (this.creatingTopics.has(instagramThreadId)) {
            logger.debug(`⏳ Topic creation for ${instagramThreadId} already in progress, waiting...`);
            return await this.creatingTopics.get(instagramThreadId);
        }

        const creationPromise = (async () => {
            if (!this.telegramChatId) {
                logger.error('❌ Telegram chat ID not configured');
                return null;
            }

            try {
                let topicName = `Instagram Chat ${instagramThreadId.substring(0, 10)}...`;
                let iconColor = 0x7ABA3C; // Default green

                // Try to get better name from user mapping
                const userInfo = this.userMappings.get(senderUserId?.toString());
                if (userInfo) {
                    topicName = `@${userInfo.username || userInfo.fullName || senderUserId}`;
                } else if (senderUserId) {
                    // Create basic user mapping if not exists
                    topicName = `User ${senderUserId}`;
                    await this.saveUserMapping(senderUserId.toString(), {
                        username: null,
                        fullName: null,
                        firstSeen: new Date(),
                        messageCount: 0
                    });
                }

                const topic = await this.telegramBot.createForumTopic(this.telegramChatId, topicName, {
                    icon_color: iconColor
                });

                let profilePicUrl = null;
                try {
                    // Fetch profile picture for the user (sender of the message)
                    if (senderUserId) {
                       // Use the instagramBot's ig instance to fetch user info
                       const userInfo = await this.instagramBot.ig.user.info(senderUserId);
                       if (userInfo?.hd_profile_pic_url_info?.url) {
                            profilePicUrl = userInfo.hd_profile_pic_url_info.url;
                       } else if (userInfo?.profile_pic_url) {
                            profilePicUrl = userInfo.profile_pic_url; // Fallback
                       }
                       logger.debug(`📸 Fetched profile pic URL for user ${senderUserId}: ${profilePicUrl}`);
                    }
                } catch (picError) {
                    logger.debug(`📸 Could not fetch profile pic for user ${senderUserId}:`, picError.message);
                }

                await this.saveChatMapping(instagramThreadId, topic.message_thread_id, profilePicUrl);
                logger.info(`🆕 Created Telegram topic: "${topicName}" (ID: ${topic.message_thread_id}) for Instagram thread ${instagramThreadId}`);

                // Send welcome message and profile picture
                if (config.telegram?.features?.welcomeMessage !== false) {
                    await this.sendWelcomeMessage(topic.message_thread_id, instagramThreadId, senderUserId, profilePicUrl);
                }

                return topic.message_thread_id;
            } catch (error) {
                logger.error('❌ Failed to create Telegram topic:', error.message);
                return null;
            } finally {
                this.creatingTopics.delete(instagramThreadId); // ✅ Cleanup after done
            }
        })();

        this.creatingTopics.set(instagramThreadId, creationPromise);
        return await creationPromise;
    }

escapeMarkdownV2(text) {
  // List of characters that need escaping in MarkdownV2
  // _ and * are included but handled carefully
  const specialChars = ['[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let escapedText = text;

  // Escape special characters
  specialChars.forEach(char => {
    const regex = new RegExp(`\\${char}`, 'g');
    escapedText = escapedText.replace(regex, `\\${char}`);
  });

  // Handle underscores and asterisks: If they are used for formatting, they should be paired.
  // If they appear literally in data, they should be escaped.
  // A simple approach: escape all underscores and asterisks that are not already escaped.
  // This might not be perfect for all Markdown but prevents parsing errors.
  // More sophisticated parsing is possible but complex.
  escapedText = escapedText.replace(/(?<!\\)_/g, '\\_'); // Escape unescaped underscores
  escapedText = escapedText.replace(/(?<!\\)\*/g, '\\*'); // Escape unescaped asterisks

  return escapedText;
}


async sendWelcomeMessage(topicId, instagramThreadId, senderUserId, initialProfilePicUrl = null) {
    try {
        const chatId = config.telegram?.chatId;
        if (!chatId) {
            logger.error('❌ Telegram chat ID not configured for welcome message');
            return;
        }

        let topicName = `Instagram Chat ${instagramThreadId.substring(0, 10)}...`;
        let username = 'Unknown';
        let fullName = 'Unknown User';
        let userDisplayId = senderUserId ? senderUserId.toString() : 'N/A';

        // Try to get better name from user mapping
        const userInfo = this.userMappings.get(senderUserId?.toString());
        if (userInfo) {
            username = userInfo.username || 'No Username';
            fullName = userInfo.fullName || 'No Full Name';
        } else if (senderUserId) {
            // Basic fallback if mapping wasn't created yet
            username = `user_${senderUserId}`;
        }

        // --- Escape user data for Markdown ---
        const escapedUsername = this.escapeMarkdownV2(username);
        const escapedFullName = this.escapeMarkdownV2(fullName);
        const escapedUserDisplayId = this.escapeMarkdownV2(userDisplayId);
        const escapedInstagramThreadId = this.escapeMarkdownV2(instagramThreadId);
        // --- End escaping ---

        // --- Use MarkdownV2 and escaped data ---
        // Avoid using '_' for emphasis if the data itself might contain '_'
        // Use '*' for emphasis or ensure '_' is escaped within the text.
        let welcomeText = `👤 *Instagram Contact Information*
📝 *Username:* ${escapedUsername}
🆔 *User ID:* ${escapedUserDisplayId}
🏷️ *Full Name:* ${escapedFullName}
📅 *First Contact:* ${new Date().toLocaleDateString()}
💬 Messages from this user will appear here`;

        const sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
            message_thread_id: topicId,
            parse_mode: 'MarkdownV2' // Use MarkdownV2 and ensure escaping
        });
        await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);

        // Send initial profile picture if available
        if (initialProfilePicUrl) {
            await this.sendProfilePictureWithUrl(topicId, instagramThreadId, initialProfilePicUrl, false);
        }
        logger.info(`🎉 Welcome message sent successfully for thread ${instagramThreadId}`);
    } catch (error) {
        const errorMessage = error.response?.body?.description || error.message;
        logger.error(`❌ Failed to send welcome message for thread ${instagramThreadId}:`, errorMessage);
    }}
    async sendProfilePictureWithUrl(topicId, instagramThreadId, profilePicUrl, isUpdate = false) {
        try {
            if (!config.telegram?.features?.profilePicSync) {
                logger.debug(`📸 Profile pic sync disabled for thread ${instagramThreadId}`);
                return;
            }
            if (!profilePicUrl) {
                logger.debug(`📸 No profile picture URL provided for thread ${instagramThreadId}`);
                return;
            }
            const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
            await this.telegramBot.sendPhoto(this.telegramChatId, profilePicUrl, {
                message_thread_id: topicId,
                caption: caption
            });
            // Always update DB and cache to ensure consistency
            await this.updateProfilePicUrl(instagramThreadId, profilePicUrl);
            this.profilePicCache.set(instagramThreadId, profilePicUrl);
            logger.info(`📸 ✅ Sent ${isUpdate ? 'updated' : 'initial'} profile picture for thread ${instagramThreadId}`);
        } catch (error) {
            logger.error(`📸 ❌ Could not send profile picture with URL for thread ${instagramThreadId}:`, error.message);
        }
    }

    async verifyTopicExists(topicId) {
        // Simple cache to avoid too many API calls
        if (this.topicVerificationCache.has(topicId)) {
            return this.topicVerificationCache.get(topicId);
        }
        try {
            // getChat can be used to check if a topic exists
            await this.telegramBot.getChat(`${this.telegramChatId}/${topicId}`);
            this.topicVerificationCache.set(topicId, true);
            return true;
        } catch (error) {
            if (error.response?.body?.error_code === 400 || error.message?.includes('chat not found')) {
                this.topicVerificationCache.set(topicId, false);
                return false;
            }
            // Other errors might be temporary, don't cache
            logger.debug(`⚠️ Error verifying topic ${topicId}:`, error.message);
            return true; // Assume it exists if unsure
        }
    }

    // --- Message Forwarding Logic ---

    async sendToTelegram(message) {
        if (!this.telegramBot || !this.enabled) return;

        try {
            const instagramThreadId = message.threadId;
            const senderUserId = message.senderId;

            // Ensure user mapping exists
            if (!this.userMappings.has(senderUserId.toString())) {
                 await this.saveUserMapping(senderUserId.toString(), {
                    username: message.senderUsername,
                    fullName: null, // Could potentially fetch this
                    firstSeen: new Date(),
                    messageCount: 0
                });
            } else {
                // Update message count
                const userData = this.userMappings.get(senderUserId.toString());
                userData.messageCount = (userData.messageCount || 0) + 1;
                userData.lastSeen = new Date();
                await this.saveUserMapping(senderUserId.toString(), userData);
            }

            const topicId = await this.getOrCreateTopic(instagramThreadId, senderUserId);
            if (!topicId) {
                logger.error(`❌ Could not get/create Telegram topic for Instagram thread ${instagramThreadId}`);
                return;
            }

            // Check filters (basic example)
            const textLower = (message.text || '').toLowerCase().trim();
            for (const word of this.filters) {
                if (textLower.startsWith(word)) {
                    logger.info(`🛑 Blocked Instagram ➝ Telegram message due to filter "${word}": ${message.text}`);
                    return; // Silently drop
                }
            }

            // Handle different message types
            if (message.type === 'text') {
                let messageText = message.text || '';
                // Add sender info if needed (e.g., group context if available later)
                // For now, assume DM context

                await this.sendSimpleMessage(topicId, messageText, instagramThreadId);
            } else if (['media', 'photo', 'video', 'clip'].includes(message.type)) {
                 // Handle media sent via Instagram API methods (broadcastPhoto, etc.)
                 // This requires the raw message data to contain media info
                 // This part is tricky without knowing the exact structure from ig_mqtt
                 // We'll handle it in the handler for now, assuming it comes through
                 // a different path or needs specific handling based on message.raw
                 logger.warn(`⚠️ Media type '${message.type}' received, handling needs specific raw data access.`);
                 // Placeholder for media handling logic if raw data is accessible
                 await this.handleInstagramMedia(message, topicId);

            } else {
                 // Handle other types or fallback to text representation
                 let fallbackText = `[Unsupported Message Type: ${message.type}]`;
                 if (message.text) {
                    fallbackText += `\n${message.text}`;
                 }
                 await this.sendSimpleMessage(topicId, fallbackText, instagramThreadId);
            }

        } catch (error) {
            logger.error('❌ Error forwarding message to Telegram:', error.message);
        }
    }

    async sendSimpleMessage(topicId, text, instagramThreadId) {
        try {
            // Check if topic still exists before sending
            const exists = await this.verifyTopicExists(topicId);
            if (!exists) {
                logger.warn(`🗑️ Topic ${topicId} for Instagram thread ${instagramThreadId} seems deleted. Recreating...`);
                // Trigger recreation logic
                this.chatMappings.delete(instagramThreadId);
                this.profilePicCache.delete(instagramThreadId);
                await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
                // The next message will trigger getOrCreateTopic again
                // Don't send now, let it retry on next message
                return null;
            }

            const sentMessage = await this.telegramBot.sendMessage(this.telegramChatId, text, {
                message_thread_id: topicId
            });
            return sentMessage.message_id;
        } catch (error) {
            const desc = error.response?.body?.description || error.message;
            if (desc.includes('message thread not found') || desc.includes('Bad Request: group chat was deactivated')) {
                logger.warn(`🗑️ Topic ID ${topicId} for Instagram thread ${instagramThreadId} is missing. Marking for recreation.`);
                this.chatMappings.delete(instagramThreadId);
                this.profilePicCache.delete(instagramThreadId);
                await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
                // Don't retry immediately, let next message handle it
            } else {
                logger.error('❌ Failed to send message to Telegram:', desc);
            }
            return null;
        }
    }

    // Placeholder for media handling - needs integration with Instagram's media download methods
    async handleInstagramMedia(message, topicId) {
         // This is complex because it requires downloading media from Instagram
         // using the `instagram-private-api` methods and then sending to Telegram.
         // The `message` object needs to contain enough raw data or references
         // to do this. Implementation depends heavily on how media messages
         // are structured in the `processedMessage` passed from your InstagramBot.
         logger.warn("Instagram media handling not fully implemented in bridge. Requires raw media data access.");
         // Example pseudo-code structure:
         /*
         try {
            // 1. Identify media type from message.raw
            // 2. Use ig.client or message context to download media buffer/stream
            //    e.g., const stream = await this.instagramBot.ig.feed.mediaDownload(message.raw.mediaId).stream();
            // 3. Save buffer to temp file
            // 4. Determine Telegram method (sendPhoto, sendVideo, etc.)
            // 5. Send using this.telegramBot.send[Type](chatId, buffer/file, { message_thread_id: topicId, caption: ... });
            // 6. Clean up temp file
         } catch (err) {
             logger.error("❌ Error handling Instagram media:", err.message);
             await this.sendSimpleMessage(topicId, `[Media: ${message.type}] ${message.text || 'No caption'}`, message.threadId);
         }
         */
    }


    // --- Telegram -> Instagram ---

    async setupTelegramHandlers() {
        if (!this.telegramBot) return;

        this.telegramBot.on('message', this.wrapHandler(async (msg) => {
            // Handle Telegram messages destined for Instagram
            if (
                (msg.chat.type === 'supergroup' || msg.chat.type === 'group') &&
                msg.is_topic_message &&
                msg.message_thread_id
            ) {
                await this.handleTelegramMessage(msg);
            } else if (msg.chat.type === 'private') {
                 // Handle direct commands to the bot if needed
                 logger.info(`📩 Received private message from Telegram user ${msg.from.id}: ${msg.text}`);
                 // Add command logic here if desired
            }
            // Ignore other message types/groups
        }));

        this.telegramBot.on('polling_error', (error) => {
            logger.error('Instagram-Telegram polling error:', error.message);
        });

        this.telegramBot.on('error', (error) => {
            logger.error('Instagram-Telegram bot error:', error.message);
        });

        logger.info('📱 Instagram-Telegram message handlers set up');
    }

    wrapHandler(handler) {
        return async (...args) => {
            try {
                await handler(...args);
            } catch (error) {
                logger.error('❌ Unhandled error in Telegram handler:', error.message);
            }
        };
    }

    async handleTelegramMessage(msg) {
        try {
            const topicId = msg.message_thread_id;
            const instagramThreadId = this.findInstagramThreadIdByTopic(topicId);

            if (!instagramThreadId) {
                logger.warn('⚠️ Could not find Instagram thread for Telegram message');
                await this.setReaction(msg.chat.id, msg.message_id, '❓'); // Question mark for unknown thread
                return;
            }

            // Send typing indicator to Instagram
            // Note: instagram-private-api might not have a direct 'typing' indicator for DMs
            // You might need to simulate it or use presence updates if available
            // await this.instagramBot.ig.realtime.direct.sendForegroundState({ ... });

            // --- Filter Check ---
            const originalText = msg.text?.trim() || '';
            const textLower = originalText.toLowerCase();
            for (const word of this.filters) {
                if (textLower.startsWith(word)) {
                    logger.info(`🛑 Blocked Telegram ➝ Instagram message due to filter "${word}": ${originalText}`);
                    await this.setReaction(msg.chat.id, msg.message_id, '🚫');
                    return;
                }
            }
            // --- End Filter Check ---

            if (msg.text) {
                const sendResult = await this.instagramBot.sendMessage(instagramThreadId, originalText);
                if (sendResult) { // Assuming sendMessage returns truthy on success
                    await this.setReaction(msg.chat.id, msg.message_id, '👍');
                    // Mark as read on Instagram side? (Usually automatic)
                } else {
                    throw new Error('Instagram send failed');
                }
            } else if (msg.photo) {
                await this.handleTelegramMedia(msg, 'photo', instagramThreadId);
            } else if (msg.video) {
                await this.handleTelegramMedia(msg, 'video', instagramThreadId);
            } else if (msg.document) {
                await this.handleTelegramMedia(msg, 'document', instagramThreadId);
            } else if (msg.voice) {
                await this.handleTelegramMedia(msg, 'voice', instagramThreadId);
            } else if (msg.sticker) {
                await this.handleTelegramMedia(msg, 'sticker', instagramThreadId);
            } else {
                // Handle other media types or fallback
                logger.warn(`⚠️ Unsupported Telegram media type received in topic ${topicId}`);
                const fallbackText = "[Unsupported Telegram Media Received]";
                const sendResult = await this.instagramBot.sendMessage(instagramThreadId, fallbackText);
                if (sendResult) {
                    await this.setReaction(msg.chat.id, msg.message_id, '👍');
                } else {
                    await this.setReaction(msg.chat.id, msg.message_id, '❌');
                }
            }

            // Send 'available' presence or stop typing indicator if used
            // await this.instagramBot.ig.realtime.direct.sendForegroundState({ inForegroundApp: true, inForegroundDevice: true, keepAliveTimeout: 900 });

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error.message);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async handleTelegramMedia(msg, mediaType, instagramThreadId) {
        try {
            await this.setReaction(msg.chat.id, msg.message_id, '🔄'); // Indicate processing

            let fileId, fileName, caption = msg.caption || '';

            switch (mediaType) {
                case 'photo':
                    fileId = msg.photo[msg.photo.length - 1].file_id; // Get largest photo
                    fileName = `photo_${Date.now()}.jpg`;
                    break;
                case 'video':
                    fileId = msg.video.file_id;
                    fileName = `video_${Date.now()}.mp4`;
                    break;
                case 'document':
                    fileId = msg.document.file_id;
                    fileName = msg.document.file_name || `document_${Date.now()}`;
                    break;
                case 'voice':
                    fileId = msg.voice.file_id;
                    fileName = `voice_${Date.now()}.ogg`;
                    break;
                case 'sticker':
                    fileId = msg.sticker.file_id;
                    fileName = `sticker_${Date.now()}.webp`;
                    break;
                default:
                    throw new Error(`Unsupported media type for sending to Instagram: ${mediaType}`);
            }

            logger.info(`📥 Downloading ${mediaType} from Telegram: ${fileName}`);
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);

            // --- Send to Instagram using instagram-private-api ---
            let sendResult;
            switch (mediaType) {
                case 'photo':
                    // Requires a square-ish image, might need processing
                    sendResult = await this.instagramBot.ig.entity.directThread(instagramThreadId).broadcastPhoto({
                        file: buffer
                        // caption: caption // Check if caption is supported directly
                    });
                    if (caption) {
                         // Send caption as a separate message if needed
                         await this.instagramBot.sendMessage(instagramThreadId, caption);
                    }
                    break;
                case 'video':
                     // Video requirements are strict (duration, dimensions, codec)
                     sendResult = await this.instagramBot.ig.entity.directThread(instagramThreadId).broadcastVideo({
                        video: buffer
                        // caption: caption
                     });
                     if (caption) {
                         await this.instagramBot.sendMessage(instagramThreadId, caption);
                     }
                    break;
                case 'document':
                    // Instagram treats documents as links/files. Might need to upload to a service first.
                    // Or send as a text message with a link if it's a file link.
                    // For now, send as text with file info.
                    const fileInfo = `📎 Document: ${msg.document.file_name || 'Unnamed File'} (${(msg.document.file_size / 1024).toFixed(2)} KB)`;
                    sendResult = await this.instagramBot.sendMessage(instagramThreadId, `${fileInfo}\n${caption}`);
                    break;
                case 'voice':
                     // Instagram might treat OGG as audio. Check format compatibility.
                     sendResult = await this.instagramBot.ig.entity.directThread(instagramThreadId).broadcastVoice({
                        file: buffer
                        // waveform: ... // Optional, complex to generate
                     });
                    break;
                case 'sticker':
                    // Sending stickers directly might not be supported or straightforward.
                    // Convert to photo or send as document link.
                    // For simplicity, send as photo (needs conversion .webp -> .png/jpg)
                    // This requires `sharp` or similar library
                    /*
                    import sharp from 'sharp';
                    const pngBuffer = await sharp(buffer).png().toBuffer();
                    sendResult = await this.instagramBot.ig.entity.directThread(instagramThreadId).broadcastPhoto({
                        file: pngBuffer
                    });
                    */
                    logger.warn("Sticker sending to Instagram not implemented. Requires .webp conversion.");
                    sendResult = await this.instagramBot.sendMessage(instagramThreadId, "[Sticker Received - Conversion Needed]");
                    break;
                default:
                    throw new Error(`Send logic not implemented for media type: ${mediaType}`);
            }

            if (sendResult) {
                logger.info(`✅ Successfully sent ${mediaType} to Instagram thread ${instagramThreadId}`);
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
            } else {
                throw new Error(`Instagram send failed for ${mediaType}`);
            }
        } catch (error) {
            logger.error(`❌ Failed to handle/send Telegram ${mediaType} to Instagram:`, error.message);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }


    async setReaction(chatId, messageId, emoji) {
        try {
            const token = config.telegram?.botToken;
            if (!token) return;
            // Use Telegram's setMessageReaction API
            await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji: emoji }]
            });
        } catch (err) {
            logger.debug('❌ Failed to set reaction:', err?.response?.data?.description || err.message);
            // Silent fail for reactions
        }
    }

    findInstagramThreadIdByTopic(topicId) {
        for (const [threadId, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return threadId;
            }
        }
        return null;
    }

    // --- Instagram Event Listeners (Setup) ---

    setupInstagramHandlers() {
        if (!this.instagramBot || !this.instagramBot.ig) {
            logger.warn('⚠️ Instagram bot instance not linked, cannot set up Instagram handlers');
            return;
        }

        // Listen for user updates (e.g., profile changes) to update topics/pics
        // This might require listening to specific realtime events or polling
        // The instagram_mqtt library might not expose all user update events directly
        // This is a placeholder for potential future integration
        /*
        this.instagramBot.ig.realtime.on('userUpdate', async (data) => {
             // Check if the user is in our mappings
             // If so, update profile pic, name, etc.
             logger.debug("Instagram user update event (not fully implemented):", data);
        });
        */

        logger.info('📱 Instagram event handlers set up for Telegram bridge');
    }

    // --- Shutdown ---

    async shutdown() {
        logger.info('🛑 Shutting down Instagram-Telegram bridge...');
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Instagram-Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error.message);
            }
        }
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error.message);
        }
        logger.info('✅ Instagram-Telegram bridge shutdown complete.');
    }
}

export { TelegramBridge };
