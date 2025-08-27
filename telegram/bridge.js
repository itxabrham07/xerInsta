import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import { connectDb } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/utils.js';

class TelegramBridge {
constructor() {
    this.instagramBot = null;
    this.telegramBot = null;
    this.botId = null; 
    this.chatMappings = new Map();
    this.userMappings = new Map();
    this.tempDir = path.join(process.cwd(), 'temp');
    this.db = null;
    this.collection = null;
    this.telegramChatId = null;
    this.creatingTopics = new Map();
    this.topicVerificationCache = new Map();
    this.enabled = false;
    this.filters = new Set();
}

    async initialize(instagramBotInstance) {
    this.instagramBot = instagramBotInstance;

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
            polling: true
        });

        // Fetch bot's own ID
        const botInfo = await this.telegramBot.getMe();
        this.botId = botInfo.id; // Store bot's ID
        logger.info(`✅ Telegram bot ID: ${this.botId}`);

        await this.setupTelegramHandlers();
        await this.loadMappingsFromDb();
        await this.loadFiltersFromDb();

        this.setupInstagramHandlers();

        this.enabled = true;
        logger.info('✅ Instagram-Telegram bridge initialized');
    } catch (error) {
        logger.error('❌ Failed to initialize Instagram-Telegram bridge:', error.message);
        this.enabled = false;
    }
}

    async initializeDatabase() {
        try {
            this.db = await connectDb();
            await this.db.command({ ping: 1 });
            logger.info('✅ MongoDB connection successful for Instagram bridge');
            this.collection = this.db.collection('bridge');
            await this.collection.createIndex({ type: 1, 'data.instagramThreadId': 1 }, { unique: true, partialFilterExpression: { type: 'chat' } });
            await this.collection.createIndex({ type: 1, 'data.instagramUserId': 1 }, { unique: true, partialFilterExpression: { type: 'user' } });
            logger.info('📊 Database initialized for Instagram bridge');
        } catch (error) {
            logger.error('❌ Failed to initialize database for Instagram bridge:', error.message);
            throw error;
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
                    case 'chat':
                        this.chatMappings.set(mapping.data.instagramThreadId, mapping.data.telegramTopicId);
                        break;
                    case 'user':
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

    async saveChatMapping(instagramThreadId, telegramTopicId) {
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
            await this.collection.updateOne(
                { type: 'chat', 'data.instagramThreadId': instagramThreadId },
                { $set: updateData },
                { upsert: true }
            );
            this.chatMappings.set(instagramThreadId, telegramTopicId);
            this.topicVerificationCache.delete(instagramThreadId);
            logger.debug(`✅ Saved chat mapping: ${instagramThreadId} -> ${telegramTopicId}`);
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

    async getOrCreateTopic(instagramThreadId, senderUserId) {
        if (this.chatMappings.has(instagramThreadId)) {
            return this.chatMappings.get(instagramThreadId);
        }

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
                let iconColor = 0x7ABA3C;

                const userInfo = this.userMappings.get(senderUserId?.toString());
                if (userInfo) {
                    topicName = `@${userInfo.username || userInfo.fullName || senderUserId}`;
                } else if (senderUserId) {
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

                await this.saveChatMapping(instagramThreadId, topic.message_thread_id);
                logger.info(`🆕 Created Telegram topic: "${topicName}" (ID: ${topic.message_thread_id}) for Instagram thread ${instagramThreadId}`);

                return topic.message_thread_id;
            } catch (error) {
                logger.error('❌ Failed to create Telegram topic:', error.message);
                return null;
            } finally {
                this.creatingTopics.delete(instagramThreadId);
            }
        })();

        this.creatingTopics.set(instagramThreadId, creationPromise);
        return await creationPromise;
    }

    async verifyTopicExists(topicId) {
        if (this.topicVerificationCache.has(topicId)) {
            return this.topicVerificationCache.get(topicId);
        }
        try {
            await this.telegramBot.getChat(`${this.telegramChatId}/${topicId}`);
            this.topicVerificationCache.set(topicId, true);
            return true;
        } catch (error) {
            if (error.response?.body?.error_code === 400 || error.message?.includes('chat not found')) {
                this.topicVerificationCache.set(topicId, false);
                return false;
            }
            logger.debug(`⚠️ Error verifying topic ${topicId}:`, error.message);
            return true;
        }
    }

    // Instagram to Telegram message forwarding
async sendToTelegram(message) {
    if (!this.telegramBot || !this.enabled) return;

    try {
        // Get the bot's own Instagram user ID
        const botUserId = this.instagramBot.ig.state.cookieUserId;
        
        // Skip messages sent by the bot itself
        if (message.senderId.toString() === botUserId.toString()) {
            logger.debug(`🤖 Ignoring message from bot itself (Instagram user ID: ${botUserId})`);
            return;
        }

        const instagramThreadId = message.threadId;
        const senderUserId = message.senderId;

        // Handle user mapping
        if (!this.userMappings.has(senderUserId.toString())) {
            await this.saveUserMapping(senderUserId.toString(), {
                username: message.senderUsername,
                fullName: null,
                firstSeen: new Date(),
                messageCount: 0
            });
        } else {
            const userData = this.userMappings.get(senderUserId.toString());
            userData.messageCount = (userData.messageCount || 0) + 1;
            userData.lastSeen = new Date();
            await this.saveUserMapping(senderUserId.toString(), userData);
        }

        // Get or create Telegram topic
        const topicId = await this.getOrCreateTopic(instagramThreadId, senderUserId);
        if (!topicId) {
            logger.error(`❌ Could not get/create Telegram topic for Instagram thread ${instagramThreadId}`);
            return;
        }

        // Filter messages based on content
        const textLower = (message.text || '').toLowerCase().trim();
        for (const word of this.filters) { // Corrected syntax: removed erroneous "-"
            if (textLower.startsWith(word)) {
                logger.info(`🛑 Blocked Instagram ➝ Telegram message due to filter "${word}": ${message.text}`);
                return;
            }
        }

        // Handle text, voice, and photo messages
        if (message.type === 'text' || !message.type) {
            let messageText = message.text || '';
            if (!messageText.trim()) {
                messageText = '[Empty message]';
            }
            await this.sendSimpleMessage(topicId, messageText, instagramThreadId);
        } else if (message.type === 'voice_media') {
            await this.handleInstagramVoice(message, topicId);
        } else if (['media', 'photo', 'raven_media'].includes(message.type)) {
            await this.handleInstagramPhoto(message, topicId);
        } else {
            logger.info(`🛑 Ignored unsupported message type: ${message.type}`);
            return;
        }

    } catch (error) {
        logger.error('❌ Error forwarding message to Telegram:', error.message);
    }
}

async handleInstagramPhoto(message, topicId) {
    try {
        if (!message.raw) {
            logger.warn("⚠️ No raw data available for Instagram photo");
            await this.sendSimpleMessage(topicId, `[Photo] ${message.text || 'No caption'}`, message.threadId);
            return;
        }

        const raw = message.raw;
        let mediaUrl = null;
        let caption = message.text || '';

        if (raw.media?.image_versions2?.candidates?.length > 0) {
            mediaUrl = raw.media.image_versions2.candidates[0].url;
        } else if (raw.visual_media?.media?.image_versions2?.candidates?.length > 0) {
            mediaUrl = raw.visual_media.media.image_versions2.candidates[0].url;
        }

        if (mediaUrl) {
            await this.telegramBot.sendPhoto(this.telegramChatId, mediaUrl, {
                message_thread_id: topicId,
                caption: caption || undefined
            });
            logger.info(`📸 ✅ Sent Instagram photo to Telegram topic ${topicId}`);
        } else {
            await this.sendSimpleMessage(topicId, `[Photo] ${caption || 'No caption'}`, message.threadId);
        }
    } catch (error) {
        logger.error("❌ Error handling Instagram photo:", error.message);
        await this.sendSimpleMessage(topicId, `[Photo] ${message.text || 'No caption'}`, message.threadId);
    }
}

async sendSimpleMessage(topicId, text, instagramThreadId) {
    try {
        const exists = await this.verifyTopicExists(topicId);
        if (!exists) {
            logger.warn(`🗑️ Topic ${topicId} for Instagram thread ${instagramThreadId} seems deleted. Recreating...`);
            this.chatMappings.delete(instagramThreadId);
            await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
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
            await this.collection.deleteOne({ type: 'chat', 'data.instagramThreadId': instagramThreadId });
        } else {
            logger.error('❌ Failed to send message to Telegram:', desc);
        }
        return null;
    }
}

async handleInstagramVoice(message, topicId) {
    try {
        if (!message.raw || !message.raw.voice_media) {
            logger.warn("⚠️ No voice media data available");
            await this.sendSimpleMessage(topicId, `🎤 Voice message received`, message.threadId);
            return;
        }

        const voiceMedia = message.raw.voice_media.media;
        if (voiceMedia && voiceMedia.audio && voiceMedia.audio.audio_src) {
            const audioUrl = voiceMedia.audio.audio_src;
            const duration = voiceMedia.audio.duration || 0;
            
            try {
                await this.telegramBot.sendVoice(this.telegramChatId, audioUrl, {
                    message_thread_id: topicId,
                    duration: duration,
                    caption: message.text || undefined
                });
                logger.info(`🎤 ✅ Sent Instagram voice message to Telegram topic ${topicId}`);
            } catch (voiceError) {
                logger.error(`❌ Failed to send voice to Telegram: ${voiceError.message}`);
                await this.sendSimpleMessage(topicId, `🎤 Voice message (${duration}s)${message.text ? `: ${message.text}` : ''}`, message.threadId);
            }
        } else {
            await this.sendSimpleMessage(topicId, `🎤 Voice message received`, message.threadId);
        }
    } catch (error) {
        logger.error("❌ Error handling Instagram voice:", error.message);
        await this.sendSimpleMessage(topicId, `🎤 Voice message received`, message.threadId);
    }
}
//////////////////
    // Telegram to Instagram handlers
    async setupTelegramHandlers() {
        if (!this.telegramBot) return;

        this.telegramBot.on('message', this.wrapHandler(async (msg) => {
            if (
                (msg.chat.type === 'supergroup' || msg.chat.type === 'group') &&
                msg.is_topic_message &&
                msg.message_thread_id
            ) {
                await this.handleTelegramMessage(msg);
            } else if (msg.chat.type === 'private') {
                logger.info(`📩 Received private message from Telegram user ${msg.from.id}: ${msg.text}`);
            }
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
        // Ignore messages sent by the bot itself
        if (msg.from.id === this.botId) {
            logger.debug(`ℹ️ Ignoring message from bot itself (ID: ${msg.from.id})`);
            return;
        }

        const topicId = msg.message_thread_id;
        const instagramThreadId = this.findInstagramThreadIdByTopic(topicId);

        if (!instagramThreadId) {
            logger.warn('⚠️ Could not find Instagram thread for Telegram message');
            await this.setReaction(msg.chat.id, msg.message_id, '❓');
            return;
        }

        // Filter check
        const originalText = msg.text?.trim() || '';
        const textLower = originalText.toLowerCase();
        for (const word of this.filters) {
            if (textLower.startsWith(word)) {
                logger.info(`🛑 Blocked Telegram ➝ Instagram message due to filter "${word}": ${originalText}`);
                await this.setReaction(msg.chat.id, msg.message_id, '🚫');
                return;
            }
        }

        // Only handle text messages from Telegram to Instagram
        if (msg.text) {
            const sendResult = await this.instagramBot.sendMessage(instagramThreadId, originalText);
            if (sendResult) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
            } else {
                throw new Error('Instagram send failed');
            }
        } else {
            // For non-text messages, inform user that only text is supported
            logger.warn(`⚠️ Non-text message received in topic ${topicId}, only text messages are supported from Telegram to Instagram`);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }

    } catch (error) {
        logger.error('❌ Failed to handle Telegram message:', error.message);
        await this.setReaction(msg.chat.id, msg.message_id, '❌');
    }
}

    async setReaction(chatId, messageId, emoji) {
        try {
            const token = config.telegram?.botToken;
            if (!token) return;
            await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji: emoji }]
            });
        } catch (err) {
            logger.debug('❌ Failed to set reaction:', err?.response?.data?.description || err.message);
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

    setupInstagramHandlers() {
        if (!this.instagramBot || !this.instagramBot.ig) {
            logger.warn('⚠️ Instagram bot instance not linked, cannot set up Instagram handlers');
            return;
        }

        logger.info('📱 Instagram event handlers set up for Telegram bridge');
    }

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
