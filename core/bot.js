import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import fs from 'fs/promises';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';

/**
 * InstagramBot manages Instagram API interactions with real-time messaging capabilities.
 */
class InstagramBot {
  #ig;
  #messageHandlers;
  #isRunning;
  #lastMessageCheck;

  constructor() {
    this.#ig = withRealtime(new IgApiClient());
    this.#messageHandlers = [];
    this.#isRunning = false;
    this.#lastMessageCheck = new Date(Date.now() - 60000);
  }

  /**
   * Logs messages with timestamp and level.
   * @param {string} level - Log level (INFO, WARN, ERROR)
   * @param {string} message - Log message
   * @param {...any} args - Additional arguments
   */
  #log(level, message, ...args) {
    console.log(`[${new Date().toISOString()}] [${level}] ${message}`, ...args);
  }

  /**
   * Logs in to Instagram using session, cookies, or credentials.
   * @throws {Error} If login fails
   */
  async login() {
    try {
      const { username, password, allowFreshLogin = true } = config.instagram ?? {};
      if (!username) throw new Error('Instagram username is missing');

      this.#ig.state.generateDevice(username);
      let loggedIn = await this.#attemptSessionLogin() || await this.#attemptCookieLogin();

      if (!loggedIn && allowFreshLogin) {
        await this.#performFreshLogin(username, password);
      } else if (!loggedIn) {
        throw new Error('No valid session or cookies, and fresh login disabled');
      }

      await this.#registerRealtimeHandlers();
      await this.#ig.realtime.connect({
        irisData: await this.#ig.feed.directInbox().request(),
      });

      const user = await this.#ig.account.currentUser();
      this.#log('INFO', `Connected as @${user.username} (ID: ${user.pk})`);
      this.#isRunning = true;
      this.#log('INFO', 'Instagram bot is running and listening for messages');
    } catch (error) {
      this.#log('ERROR', 'Failed to initialize bot:', error.message);
      throw error;
    }
  }

  /**
   * Attempts login using saved session.
   * @returns {Promise<boolean>} True if login successful
   */
  async #attemptSessionLogin() {
    try {
      await fs.access('./session.json');
      this.#log('INFO', 'Found session.json, attempting login...');
      const sessionData = JSON.parse(await fs.readFile('./session.json', 'utf-8'));
      await this.#ig.state.deserialize(sessionData);
      await this.#ig.account.currentUser();
      this.#log('INFO', 'Logged in from session.json');
      return true;
    } catch (error) {
      this.#log('WARN', 'Session login failed:', error.message);
      return false;
    }
  }

  /**
   * Attempts login using saved cookies.
   * @returns {Promise<boolean>} True if login successful
   */
  async #attemptCookieLogin() {
    try {
      this.#log('INFO', 'Attempting cookie-based login...');
      await this.#loadCookiesFromJson();
      await this.#ig.account.currentUser();
      this.#log('INFO', 'Logged in using cookies.json');
      await this.#saveSession();
      return true;
    } catch (error) {
      this.#log('ERROR', 'Cookie login failed:', error.message);
      return false;
    }
  }

  /**
   * Performs fresh login with credentials.
   * @param {string} username - Instagram username
   * @param {string} password - Instagram password
   */
  async #performFreshLogin(username, password) {
    this.#log('INFO', 'Performing fresh login...');
    await this.#ig.account.login(username, password);
    this.#log('INFO', 'Fresh login successful');
    await this.#saveSession();
  }

  /**
   * Saves current session to file.
   */
  async #saveSession() {
    const session = await this.#ig.state.serialize();
    delete session.constants;
    await fs.writeFile('./session.json', JSON.stringify(session, null, 2));
    this.#log('INFO', 'Session saved to session.json');
  }

  /**
   * Loads cookies from JSON file.
   * @param {string} [path='./cookies.json'] - Path to cookies file
   */
  async #loadCookiesFromJson(path = './cookies.json') {
    try {
      const cookies = JSON.parse(await fs.readFile(path, 'utf-8'));
      for (const cookie of cookies) {
        const toughCookie = new tough.Cookie({
          key: cookie.name,
          value: cookie.value,
          domain: cookie.domain.replace(/^\./, ''),
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly !== false,
          expires: cookie.expirationDate ? new Date(cookie.expirationDate * 1000) : undefined,
        });
        await this.#ig.state.cookieJar.setCookie(toughCookie.toString(), `https://${toughCookie.domain}${toughCookie.path}`);
      }
      this.#log('INFO', `Loaded ${cookies.length} cookies from file`);
    } catch (error) {
      this.#log('ERROR', 'Error loading cookies:', error.message);
      throw error;
    }
  }

  /**
   * Registers real-time event handlers.
   */
  #registerRealtimeHandlers() {
    this.#log('INFO', 'Registering real-time event handlers...');

    this.#ig.realtime.on('message', async (data) => {
      if (!data.message || !this.#isNewMessage(data.message)) return;
      this.#log('INFO', 'Processing new message...');
      await this.#handleMessage(data.message, data);
    });

    this.#ig.realtime.on('direct', async (data) => {
      if (!data.message || !this.#isNewMessage(data.message)) return;
      this.#log('INFO', 'Processing new direct message...');
      await this.#handleMessage(data.message, data);
    });

    this.#ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message')) {
        this.#log('INFO', `Received: ${topicStr}`);
      }
    });

    this.#ig.realtime.on('error', (error) => this.#log('ERROR', 'Realtime error:', error.message || error));
    this.#ig.realtime.on('close', () => this.#log('WARN', 'Realtime connection closed'));
  }

  /**
   * Checks if a message is new based on timestamp.
   * @param {Object} message - Message object
   * @returns {boolean} True if message is new
   */
  #isNewMessage(message) {
    try {
      const messageTime = new Date(parseInt(message.timestamp) / 1000);
      const isNew = messageTime > this.#lastMessageCheck;
      this.#log('INFO', `Message time: ${messageTime.toISOString()}, Last check: ${this.#lastMessageCheck.toISOString()}`);
      if (isNew) {
        this.#lastMessageCheck = messageTime;
        this.#log('INFO', 'Message is new');
      } else {
        this.#log('WARN', 'Message is old');
      }
      return isNew;
    } catch (error) {
      this.#log('ERROR', 'Error checking message timestamp:', error.message);
      return true;
    }
  }

  /**
   * Processes incoming messages.
   * @param {Object} message - Message object
   * @param {Object} eventData - Event data
   */
  async #handleMessage(message, eventData) {
    try {
      const sender = eventData.thread?.users?.find(u => u.pk?.toString() === message.user_id?.toString());
      const processedMessage = {
        id: message.item_id,
        text: message.text || '',
        sender: message.user_id,
        senderUsername: sender?.username || `user_${message.user_id}`,
        timestamp: new Date(parseInt(message.timestamp) / 1000),
        threadId: eventData.thread?.thread_id || message.thread_id || 'unknown',
        threadTitle: eventData.thread?.thread_title || 'Direct Message',
        type: message.item_type,
      };

      this.#log('INFO', `New message from @${processedMessage.senderUsername}: ${processedMessage.text}`);
      for (const handler of this.#messageHandlers) {
        try {
          await handler(processedMessage);
        } catch (error) {
          this.#log('ERROR', 'Message handler error:', error.message);
        }
      }
    } catch (error) {
      this.#log('ERROR', 'Error handling message:', error.message);
    }
  }

  /**
   * Registers a message handler.
   * @param {Function} handler - Message handler function
   */
  onMessage(handler) {
    this.#messageHandlers.push(handler);
    this.#log('INFO', `Added message handler (total: ${this.#messageHandlers.length})`);
  }

  /**
   * Sends a message to a thread.
   * @param {string} threadId - Thread ID
   * @param {string} text - Message text
   * @returns {Promise<boolean>} True if sent successfully
   */
  async sendMessage(threadId, text) {
    try {
      await this.#ig.entity.directThread(threadId).broadcastText(text);
      this.#log('INFO', `Sent message to thread ${threadId}: ${text}`);
      return true;
    } catch (error) {
      this.#log('ERROR', 'Error sending message:', error.message);
      throw error;
    }
  }

  /**
   * Disconnects from Instagram.
   */
  async disconnect() {
    this.#log('INFO', 'Disconnecting from Instagram...');
    this.#isRunning = false;
    try {
      await this.#ig.realtime.disconnect();
      this.#log('INFO', 'Disconnected successfully');
    } catch (error) {
      this.#log('WARN', 'Error during disconnect:', error.message);
    }
  }
}

/**
 * Main execution function to start the bot.
 */
async function main() {
  try {
    const bot = new InstagramBot();
    await bot.login();

    const moduleManager = new ModuleManager(bot);
    await moduleManager.loadModules();

    const messageHandler = new MessageHandler(bot, moduleManager, null);
    bot.onMessage((message) => messageHandler.handleMessage(message));

    console.log('Bot is running with full module support. Type .help or use your commands.');

    setInterval(() => {
      console.log(`💓 Bot heartbeat - Running: ${bot.#isRunning}, Last check: ${bot.#lastMessageCheck.toISOString()}`);
    }, 300000);

    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await bot.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error('Bot failed to start:', error.message);
    process.exit(1);
  }
}

main();

export { InstagramBot };
