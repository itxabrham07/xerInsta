import { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';

/**
 * InstagramBot class to manage Instagram interactions via the private API and MQTT.
 */
class InstagramBot {
  /**
   * Initializes the InstagramBot with necessary properties.
   */
  constructor() {
    this.ig = withRealtime(new IgApiClient());
    this.messageHandlers = [];
    this.isRunning = false;
    this.lastMessageCheck = new Date(Date.now() - 60000);
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
    this.userCache = new Map(); // Cache for user info
    
    // File paths for persistence
    this.paths = {
      session: './session.json',
      cookies: './cookies.json',
      device: './device.json'
    };
  }

  /**
   * Sleep utility function
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Logs messages with timestamp and log level.
   * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG, TRACE).
   * @param {string} message - The message to log.
   * @param {...any} args - Additional arguments to log.
   */
  log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`, ...args);
  }

  // ---------- Device Persistence ----------
  async initDevice(username) {
    try {
      const raw = await fs.readFile(this.paths.device, 'utf-8');
      const dev = JSON.parse(raw);
      if (dev.username === username && dev.deviceString) {
        this.ig.state.deviceString = dev.deviceString;
        this.ig.state.deviceId = dev.deviceId;
        this.ig.state.uuid = dev.uuid;
        this.ig.state.phoneId = dev.phoneId;
        this.ig.state.adid = dev.adid;
        this.log('INFO', `Loaded persistent device for @${username}`);
        return;
      }
      this.log('WARN', 'Device file present but mismatched username or malformed; regenerating.');
    } catch {
      this.log('INFO', 'No device.json found; generating new device.');
    }

    this.ig.state.generateDevice(username);
    await this.saveDevice(username);
  }

  async saveDevice(username) {
    const dev = {
      username,
      deviceString: this.ig.state.deviceString,
      deviceId: this.ig.state.deviceId,
      uuid: this.ig.state.uuid,
      phoneId: this.ig.state.phoneId,
      adid: this.ig.state.adid,
    };
    await fs.writeFile(this.paths.device, JSON.stringify(dev, null, 2));
    this.log('INFO', `Saved device fingerprint for @${username}`);
  }

  // ---------- Login Flow ----------
  /**
   * Enhanced login method with device persistence and structured flow
   * @throws {Error} If login fails due to missing credentials or invalid session/cookies.
   */
  async login() {
    const username = config.instagram?.username;
    const password = config.instagram?.password;
    const forceFresh = Boolean(config.instagram?.forceFreshLogin);

    if (!username) throw new Error('INSTAGRAM_USERNAME is missing');

    await this.initDevice(username);

    if (!forceFresh) {
      // 1) Try session.json
      if (await this.trySessionLogin()) {
        await this.postLogin();
        return;
      }

      // 2) Try cookies.json
      if (await this.tryCookieLogin()) {
        await this.postLogin();
        return;
      }
    } else {
      this.log('INFO', 'forceFreshLogin=true, skipping session/cookies.');
    }

    // 3) Fresh login
    if (!password) throw new Error('No valid login method; set instagram.password for fresh login.');
    await this.freshLogin(username, password);
    await this.postLogin();
  }

  async trySessionLogin() {
    try {
      const raw = await fs.readFile(this.paths.session, 'utf-8');
      const sessionData = JSON.parse(raw);
      await this.ig.state.deserialize(sessionData);
      await this.ig.account.currentUser();
      this.log('INFO', 'Logged in using session.json');
      return true;
    } catch (err) {
      this.log('WARN', `Session login failed: ${err?.message || err}`);
      return false;
    }
  }

  async tryCookieLogin() {
    try {
      await this.loadCookiesFromJson(this.paths.cookies);
      await this.ig.account.currentUser();
      this.log('INFO', 'Logged in using cookies.json');
      await this.saveSession();
      return true;
    } catch (err) {
      this.log('WARN', `Cookie login failed: ${err?.message || err}`);
      return false;
    }
  }

  async freshLogin(username, password) {
    try {
      this.log('INFO', 'Attempting fresh login...');
      await this.ig.account.login(username, password);
      this.log('INFO', `Fresh login successful as @${username}`);
      
      // Add delay after fresh login to avoid rate limiting
      this.log('INFO', 'Waiting 30 seconds after fresh login to avoid rate limits...');
      await this.sleep(30000);
      
      await this.saveSession();
    } catch (err) {
      // Checkpoint flow (review/verify)
      if (err instanceof IgCheckpointError || err?.name === 'IgCheckpointError') {
        this.log('WARN', 'Checkpoint required. Attempting auto-resolution...');
        try {
          await this.ig.challenge.auto(true);
          await this.ig.account.currentUser();
          this.log('INFO', 'Checkpoint auto-resolved.');
          await this.saveSession();
          return;
        } catch (e2) {
          this.log('ERROR', `Checkpoint auto-resolution failed: ${e2?.message || e2}`);
        }
      }

      throw err;
    }
  }

  async saveSession() {
    const session = await this.ig.state.serialize();
    delete session.constants;
    await fs.writeFile(this.paths.session, JSON.stringify(session, null, 2));
    this.log('INFO', 'Session saved to session.json');
  }

  async loadCookiesFromJson(path) {
    const raw = await fs.readFile(path, 'utf-8');
    const cookies = JSON.parse(raw);
    let loaded = 0;
    for (const cookie of cookies) {
      const tc = new tough.Cookie({
        key: cookie.name,
        value: cookie.value,
        domain: (cookie.domain || '').replace(/^\./, ''),
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly !== false,
      });
      await this.ig.state.cookieJar.setCookie(tc.toString(), `https://${tc.domain}${tc.path}`);
      loaded++;
    }
    this.log('INFO', `Loaded ${loaded}/${cookies.length} cookies`);
  }

  /**
   * Post-login setup: register handlers and connect to real-time
   */
  async postLogin() {
    try {
      // Register handlers and connect to real-time
      this.registerRealtimeHandlers();
      await this.ig.realtime.connect({
        graphQlSubs: [
          GraphQLSubscriptions.getAppPresenceSubscription(),
          GraphQLSubscriptions.getZeroProvisionSubscription(this.ig.state.phoneId),
          GraphQLSubscriptions.getDirectStatusSubscription(),
          GraphQLSubscriptions.getDirectTypingSubscription(this.ig.state.cookieUserId),
          GraphQLSubscriptions.getAsyncAdSubscription(this.ig.state.cookieUserId),
        ],
        skywalkerSubs: [
          SkywalkerSubscriptions.directSub(this.ig.state.cookieUserId),
          SkywalkerSubscriptions.liveSub(this.ig.state.cookieUserId),
        ],
        irisData: await this.ig.feed.directInbox().request(),
        connectOverrides: {},
        socksOptions: config.proxy ? {
          type: config.proxy.type || 5,
          host: config.proxy.host,
          port: config.proxy.port,
          userId: config.proxy.username,
          password: config.proxy.password,
        } : undefined,
      });

      // Simulate mobile app in foreground
      await this.setForegroundState(true, true, 60);
      this.isRunning = true;
      this.log('INFO', 'Instagram bot is running and listening for messages');
    } catch (error) {
      this.log('ERROR', 'Failed to initialize bot:', error.message);
      throw error;
    }
  }

  /**
   * Registers real-time event handlers for Instagram events.
   */
  registerRealtimeHandlers() {
    this.log('INFO', 'Registering real-time event handlers...');

    // Handle direct messages
    this.ig.realtime.on('message', async (data) => {
      if (!data.message) {
        this.log('WARN', 'No message payload in event data');
        return;
      }
      if (!this.isNewMessageById(data.message.item_id)) {
        this.log('DEBUG', `Message ${data.message.item_id} filtered as duplicate`);
        return;
      }
      await this.handleMessage(data.message, data);
    });

    // Handle other direct events
    this.ig.realtime.on('direct', async (data) => {
      if (data.message && this.isNewMessageById(data.message.item_id)) {
        await this.handleMessage(data.message, data);
      } else {
        this.log('DEBUG', 'Received non-message direct event:', JSON.stringify(data, null, 2));
      }
    });

    // General receive event for debugging
    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message') || topicStr.includes('iris')) {
        this.log('DEBUG', `Received on topic: ${topicStr}`, JSON.stringify(messages, null, 2));
      }
    });

    // Connection lifecycle events
    this.ig.realtime.on('error', (err) => {
      this.log('ERROR', 'Realtime connection error:', err.message);
    });

    this.ig.realtime.on('close', () => {
      this.log('WARN', 'Realtime connection closed');
      this.isRunning = false;
    });

    this.ig.realtime.on('connect', () => {
      this.log('INFO', 'Realtime connection established');
      this.isRunning = true;
    });

    this.ig.realtime.on('reconnect', () => {
      this.log('INFO', 'Realtime client is reconnecting');
    });
  }

  /**
   * Checks if a message is new based on its ID.
   * @param {string} messageId - The message ID.
   * @returns {boolean} True if the message is new.
   */
  isNewMessageById(messageId) {
    if (!messageId) {
      this.log('WARN', 'Missing message ID');
      return true;
    }
    if (this.processedMessageIds.has(messageId)) {
      return false;
    }
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > this.maxProcessedMessageIds) {
      const first = this.processedMessageIds.values().next().value;
      this.processedMessageIds.delete(first);
    }
    return true;
  }

  /**
   * Fetches username for a user ID, using cache or API.
   * @param {string} userId - The Instagram user ID.
   * @returns {string} The username or fallback ID.
   */
  async getUsername(userId) {
    if (!userId) return `user_${userId || 'unknown'}`;
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId);
    }
    try {
      const userInfo = await this.ig.user.info(userId);
      const username = userInfo.username || `user_${userId}`;
      this.userCache.set(userId, username);
      this.log('DEBUG', `Fetched username ${username} for user ID ${userId}`);
      return username;
    } catch (error) {
      this.log('ERROR', `Failed to fetch username for user ID ${userId}:`, error.message);
      return `user_${userId}`;
    }
  }

  /**
   * Handles incoming messages.
   * @param {object} message - The message object.
   * @param {object} eventData - Additional event data.
   */
  async handleMessage(message, eventData) {
    try {
      if (!message || !message.user_id || !message.item_id) {
        this.log('WARN', 'Received malformed message');
        return;
      }

      let senderUsername = `user_${message.user_id}`;
      if (eventData.thread?.users) {
        const sender = eventData.thread.users.find(u => u.pk?.toString() === message.user_id?.toString());
        if (sender?.username) {
          senderUsername = sender.username;
        } else {
          senderUsername = await this.getUsername(message.user_id);
        }
      } else {
        senderUsername = await this.getUsername(message.user_id);
      }

      const processedMessage = {
        id: message.item_id,
        text: message.text || '',
        senderId: message.user_id,
        senderUsername,
        timestamp: new Date(parseInt(message.timestamp, 10) / 1000),
        threadId: eventData.thread?.thread_id || message.thread_id || 'unknown_thread',
        threadTitle: eventData.thread?.thread_title || message.thread_title || 'Direct Message',
        type: message.item_type || 'unknown_type',
        raw: message,
      };

      this.log('INFO', `[${processedMessage.threadTitle}] New message from @${processedMessage.senderUsername}: "${processedMessage.text}"`);

      for (const handler of this.messageHandlers) {
        await handler(processedMessage);
      }
    } catch (error) {
      this.log('ERROR', 'Error handling message:', error.message);
    }
  }

  /**
   * Registers a message handler.
   * @param {Function} handler - The handler function.
   */
  onMessage(handler) {
    if (typeof handler === 'function') {
      this.messageHandlers.push(handler);
      this.log('INFO', `Added message handler (total: ${this.messageHandlers.length})`);
    } else {
      this.log('WARN', 'Attempted to add non-function message handler');
    }
  }

  /**
   * Sends a text message to a thread.
   * @param {string} threadId - The thread ID.
   * @param {string} text - The message text.
   * @returns {boolean} True if sent successfully.
   */
  async sendMessage(threadId, text) {
    if (!threadId || !text) {
      this.log('WARN', 'Missing threadId or text');
      throw new Error('Thread ID and text are required');
    }
    try {
      await this.ig.entity.directThread(threadId).broadcastText(text);
      this.log('INFO', `Text message sent to thread ${threadId}: "${text}"`);
      return true;
    } catch (error) {
      this.log('ERROR', `Error sending text message to thread ${threadId}:`, error.message);
      throw error;
    }
  }

  /**
   * Sets the app/device foreground state to simulate mobile activity.
   * @param {boolean} inApp - App foreground state.
   * @param {boolean} inDevice - Device foreground state.
   * @param {number} timeoutSeconds - Timeout in seconds.
   * @returns {boolean} True if state is set successfully.
   */
  async setForegroundState(inApp = true, inDevice = true, timeoutSeconds = 60) {
    const timeout = inApp ? Math.max(10, timeoutSeconds) : 900;
    try {
      await this.ig.realtime.direct.sendForegroundState({
        inForegroundApp: Boolean(inApp),
        inForegroundDevice: Boolean(inDevice),
        keepAliveTimeout: timeout,
      });
      this.log('INFO', `Foreground state set: App=${inApp}, Device=${inDevice}, Timeout=${timeout}s`);
      return true;
    } catch (error) {
      this.log('ERROR', 'Failed to set foreground state:', error.message);
      return false;
    }
  }

  /**
   * Simulates toggling device state to mimic mobile app behavior.
   */
  async simulateDeviceToggle() {
    this.log('INFO', 'Starting device simulation: Turning OFF...');
    const offSuccess = await this.setForegroundState(false, false, 900);
    if (!offSuccess) {
      this.log('WARN', 'Simulation step 1 (device off) failed');
    }

    setTimeout(async () => {
      this.log('INFO', 'Simulation: Turning device ON...');
      const onSuccess = await this.setForegroundState(true, true, 60);
      this.log(onSuccess ? 'INFO' : 'WARN', 
        onSuccess ? 'Device simulation cycle completed' : 'Simulation step 2 (device on) failed');
    }, 5000);
  }

  /**
   * Gracefully disconnects the bot.
   */
  async disconnect() {
    this.log('INFO', 'Initiating graceful disconnect...');
    this.isRunning = false;

    try {
      await this.setForegroundState(false, false, 900);
    } catch (error) {
      this.log('WARN', 'Error setting background state:', error.message);
    }

    try {
      if (this.ig.realtime?.disconnect) {
        await this.ig.realtime.disconnect();
        this.log('INFO', 'Disconnected from Instagram realtime');
      }
    } catch (error) {
      this.log('WARN', 'Error during disconnect:', error.message);
    }
  }
}

/**
 * Main execution logic for the bot.
 */
async function main() {
  let bot;
  try {
    bot = new InstagramBot();
    await bot.login();

    const moduleManager = new ModuleManager(bot);
    await moduleManager.loadModules();

    const messageHandler = new MessageHandler(bot, moduleManager, null);
    bot.onMessage((message) => messageHandler.handleMessage(message));

    console.log('Bot is running with full module support. Type .help for commands.');

    setInterval(() => {
      console.log(`[${new Date().toISOString()}] Bot heartbeat - Running: ${bot.isRunning}`);
    }, 300000);

    const shutdownHandler = async () => {
      console.log('\n[SIGINT/SIGTERM] Shutting down gracefully...');
      if (bot) await bot.disconnect();
      console.log('Shutdown complete.');
      process.exit(0);
    };

    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);
  } catch (error) {
    console.error('Bot failed to start:', error.message);
    if (bot) await bot.disconnect();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Unhandled error in main:', error.message);
    process.exit(1);
  });
}

export { InstagramBot };
