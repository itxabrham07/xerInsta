// telegram/bridge.js - Simplified Version
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
        this.chatMappings = new Map(); // instagramThreadId -> telegramTopicId
        this.tempDir = path.join(process.cwd(), 'temp');
        this.db = null;
        this.collection = null;
        this.telegramChatId = null;
        this.enabled = false;
        this.myInstagramUserId = null; // Store our own Instagram user ID
    }

    async initialize(instagramBotInstance) {
        this.instagramBot = instagramBotInstance;
        
        if (!this.instagramBot) {
            logger.error('Instagram bot instance not provided to Telegram bridge');
            throw new Error('Instagram bot instance is required');
        }

        const token = config.telegram?.botToken;
        this.telegramChatId = config.telegram?.chatId;

        if (!token || token.includes('YOUR_BOT_TOKEN') || !this.telegramChatId || this.telegramChatId.includes('YOUR_CHAT_ID')) {
            logger.warn('Telegram bot token or chat ID not configured');
            return;
        }

        try {
            await this.initializeDatabase();
            await fs.ensureDir(this.tempDir);
            
            this.telegramBot = new TelegramBot(token, { polling: true });
            
            // Get our Instagram user ID to filter out our own messages
            if (this.instagramBot.ig) {
                const currentUser = await this.instagramBot.ig.account.currentUser();
                this.myInstagramUserId = currentUser.pk.toString();
                logger.info(`My Instagram user ID: ${this.myInstagramUserId}`);
            }

            await this.setupTelegramHandlers();
            await this.loadMappingsFromDb();

            this.enabled = true;
            logger.info('Instagram-Telegram bridge initialized (simplified)');
        } catch (error) {
            logger.error('Failed to initialize Instagram-Telegram bridge:', error.message);
            this.enabled = false;
        }
    }

    async initializeDatabase() {
        try {
            this.db = await connectDb();
            this.collection = this.db.collection('bridge');
            await this.collection.createIndex(
                { type: 1, 'data.instagramThreadId': 1 }, 
                { unique: true, partialFilterExpression: { type: 'chat' } }
            );
            logger.info('Database initialized for bridge');
        } catch (error) {
            logger.error('Failed to initialize database:', error.message);
            throw error;
        }
    }

    async loadMappingsFromDb() {
        if (!this.collection) return;
        
        try {
            const mappings = await this.collection.find({ type: 'chat' }).toArray();
            for (const mapping of mappings) {
                this.chatMappings.set(mapping.data.instagramThreadId, mapping.data.telegramTopicId);
            }
            logger.info(`Loaded ${this.chatMappings.size} chat mappings`);
        } catch (error) {
            logger.error('Failed to load mappings:', error.message);
        }
    }

    async saveChatMapping(instagramThreadId, telegramTopicId) {
        if (!this.collection) return;
        
        try {
            await this.collection.updateOne(
                { type: 'chat', 'data.instagramThreadId': instagramThreadId },
                {
                    $set: {
                        type: 'chat',
                        data: {
                            instagramThreadId,
                            telegramTopicId,
                            createdAt: new Date()
                        }
                    }
                },
                { upsert: true }
            );
            this.chatMappings.set(instagramThreadId, telegramTopicId);
            logger.debug(`Saved chat mapping: ${instagramThreadId} -> ${telegramTopicId}`);
        } catch (error) {
            logger.error('Failed to save chat mapping:', error.message);
        }
    }

    // Create or get existing topic for Instagram thread
    async getOrCreateTopic(instagramThreadId, senderUsername = null) {
        if (this.chatMappings.has(instagramThreadId)) {
            return this.chatMappings.get(instagramThreadId);
        }

        if (!this.telegramChatId) {
            logger.error('Telegram chat ID not configured');
            return null;
        }

        try {
            const topicName = senderUsername ? `@${senderUsername}` : `Chat ${instagramThreadId.substring(0, 8)}`;
            
            const topic = await this.telegramBot.createForumTopic(this.telegramChatId, topicName, {
                icon_color: 0x7ABA3C
            });

            await this.saveChatMapping(instagramThreadId, topic.message_thread_id);
            logger.info(`Created Telegram topic: "${topicName}" (ID: ${topic.message_thread_id})`);

            return topic.message_thread_id;
        } catch (error) {
            logger.error('Failed to create Telegram topic:', error.message);
            return null;
        }
    }

    // Instagram -> Telegram: Forward messages (text, voice, photos)
    async sendToTelegram(message) {
        if (!this.telegramBot || !this.enabled) return;

        // Skip messages from ourselves
        if (message.senderId && message.senderId.toString() === this.myInstagramUserId) {
            logger.debug('Skipping message from self');
            return;
        }

        try {
            const topicId = await this.getOrCreateTopic(message.threadId, message.senderUsername);
            if (!topicId) {
                logger.error('Could not get/create Telegram topic');
                return;
            }

            if (message.type === 'text' || !message.type) {
                const messageText = message.text || '[Empty message]';
                await this.sendTextMessage(topicId, messageText);
            } else if (message.type === 'voice_media') {
                await this.handleInstagramVoice(message, topicId);
            } else if (['media', 'photo', 'video'].includes(message.type)) {
                await this.handleInstagramMedia(message, topicId);
            } else {
                // Fallback for other message types
                const fallbackText = `[${message.type || 'Unknown'} Message]${message.text ? `\n${message.text}` : ''}`;
                await this.sendTextMessage(topicId, fallbackText);
            }

        } catch (error) {
            logger.error('Error forwarding message to Telegram:', error.message);
        }
    }

    async sendTextMessage(topicId, text) {
        try {
            await this.telegramBot.sendMessage(this.telegramChatId, text, {
                message_thread_id: topicId
            });
            return true;
        } catch (error) {
            logger.error('Failed to send text to Telegram:', error.message);
            return false;
        }
    }

    async handleInstagramVoice(message, topicId) {
        try {
            if (!message.raw?.voice_media?.media?.audio?.audio_src) {
                await this.sendTextMessage(topicId, 'Voice message received');
                return;
            }

            const audioUrl = message.raw.voice_media.media.audio.audio_src;
            const duration = message.raw.voice_media.media.audio.duration || 0;

            try {
                await this.telegramBot.sendVoice(this.telegramChatId, audioUrl, {
                    message_thread_id: topicId,
                    duration: duration,
                    caption: message.text || undefined
                });
                logger.info('Sent Instagram voice message to Telegram');
            } catch (voiceError) {
                logger.error('Failed to send voice:', voiceError.message);
                // Fallback to text
                await this.sendTextMessage(topicId, `Voice message (${duration}s)${message.text ? `: ${message.text}` : ''}`);
            }
        } catch (error) {
            logger.error('Error handling Instagram voice:', error.message);
            await this.sendTextMessage(topicId, 'Voice message received');
        }
    }

    async handleInstagramMedia(message, topicId) {
        try {
            if (!message.raw) {
                await this.sendTextMessage(topicId, `[Media: ${message.type}] ${message.text || ''}`);
                return;
            }

            let mediaUrl = null;
            let mediaType = 'photo';
            const caption = message.text || '';

            // Extract media URL from different possible structures
            if (message.raw.media) {
                if (message.raw.media.image_versions2?.candidates?.length > 0) {
                    mediaUrl = message.raw.media.image_versions2.candidates[0].url;
                    mediaType = 'photo';
                } else if (message.raw.media.video_versions?.length > 0) {
                    mediaUrl = message.raw.media.video_versions[0].url;
                    mediaType = 'video';
                }
            } else if (message.raw.visual_media?.media) {
                const media = message.raw.visual_media.media;
                if (media.image_versions2?.candidates?.length > 0) {
                    mediaUrl = media.image_versions2.candidates[0].url;
                    mediaType = 'photo';
                } else if (media.video_versions?.length > 0) {
                    mediaUrl = media.video_versions[0].url;
                    mediaType = 'video';
                }
            }

            if (mediaUrl) {
                try {
                    if (mediaType === 'photo') {
                        await this.telegramBot.sendPhoto(this.telegramChatId, mediaUrl, {
                            message_thread_id: topicId,
                            caption: caption || undefined
                        });
                    } else if (mediaType === 'video') {
                        await this.telegramBot.sendVideo(this.telegramChatId, mediaUrl, {
                            message_thread_id: topicId,
                            caption: caption || undefined
                        });
                    }
                    logger.info(`Sent Instagram ${mediaType} to Telegram`);
                } catch (mediaError) {
                    logger.error(`Failed to send ${mediaType}:`, mediaError.message);
                    await this.sendTextMessage(topicId, `[Media: ${message.type}] ${caption}`);
                }
            } else {
                await this.sendTextMessage(topicId, `[Media: ${message.type}] ${caption}`);
            }
        } catch (error) {
            logger.error('Error handling Instagram media:', error.message);
            await this.sendTextMessage(topicId, `[Media: ${message.type}] ${message.text || ''}`);
        }
    }

    // Telegram -> Instagram: Only text messages
    async setupTelegramHandlers() {
        if (!this.telegramBot) return;

        this.telegramBot.on('message', async (msg) => {
            try {
                // Only handle messages in forum topics (supergroup with topic)
                if (
                    (msg.chat.type === 'supergroup' || msg.chat.type === 'group') &&
                    msg.is_topic_message &&
                    msg.message_thread_id &&
                    msg.text // Only text messages
                ) {
                    await this.handleTelegramMessage(msg);
                }
            } catch (error) {
                logger.error('Error in Telegram handler:', error.message);
            }
        });

        this.telegramBot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error.message);
        });

        logger.info('Telegram message handlers set up');
    }

    async handleTelegramMessage(msg) {
        try {
            if (!this.instagramBot) {
                logger.error('Instagram bot not available');
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
                return;
            }

            const topicId = msg.message_thread_id;
            const instagramThreadId = this.findInstagramThreadIdByTopic(topicId);

            if (!instagramThreadId) {
                logger.warn('Could not find Instagram thread for Telegram message');
                await this.setReaction(msg.chat.id, msg.message_id, '❓');
                return;
            }

            const text = msg.text.trim();
            if (!text) {
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
                return;
            }

            // Send text to Instagram
            const success = await this.sendTextToInstagram(text, instagramThreadId);
            
            if (success) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
            } else {
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
            }

        } catch (error) {
            logger.error('Failed to handle Telegram message:', error.message);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async sendTextToInstagram(text, instagramThreadId) {
        try {
            const result = await this.instagramBot.sendMessage(instagramThreadId, text);
            return !!result;
        } catch (error) {
            logger.error('Failed to send text to Instagram:', error.message);
            return false;
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
        } catch (error) {
            logger.debug('Failed to set reaction:', error.message);
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

    async shutdown() {
        logger.info('Shutting down Instagram-Telegram bridge...');
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('Telegram bot polling stopped');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error.message);
            }
        }
        
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('Temp directory cleaned');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error.message);
        }
        
        logger.info('Bridge shutdown complete');
    }
}

export { TelegramBridge };
