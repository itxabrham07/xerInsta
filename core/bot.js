import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';
import crypto from 'crypto';

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
    
    // File paths
    this.paths = {
      device: './device.json',
      session: './session.json',
      cookies: './cookies.json'
    };
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

  // ---------- Checkpoint Auto-Resolver ----------
  async resolveCheckpoint(challenge) {
    try {
      this.log('INFO', 'Checkpoint detected, attempting auto-resolution...');
      
      if (challenge.step_name === 'select_verify_method') {
        const choices = challenge.step_data?.choice_list || [];
        const emailChoice = choices.find(choice => choice.label && choice.label.includes('email'));
        
        if (emailChoice) {
          this.log('INFO', 'Selecting email verification method...');
          await this.ig.challenge.selectVerifyMethod(challenge.step_name, emailChoice.value);
          return true;
        }
      }
      
      if (challenge.step_name === 'verify_email') {
        this.log('WARN', 'Email verification required. Attempting bypass...');
        // Try to skip email verification
        try {
          await this.ig.challenge.submitPhoneNumber('');
          return true;
        } catch {
          return false;
        }
      }
      
      if (challenge.step_name === 'submit_phone') {
        this.log('INFO', 'Attempting to skip phone verification...');
        return false;
      }
      
      this.log('WARN', `Unhandled checkpoint step: ${challenge.step_name}`);
      return false;
      
    } catch (error) {
      this.log('ERROR', 'Checkpoint resolution failed:', error.message);
      return false;
    }
  }

  // ---------- Fresh Login with 2FA Bypass ----------
  async freshLogin(username, password) {
    try {
      this.log('INFO', `Attempting fresh login for @${username}...`);
      
      // Pre-login setup
      this.ig.request.end$.subscribe(async () => {
        await this.delay(Math.floor(Math.random() * 1000) + 500);
      });
      
      // Simulate app startup
      await this.ig.simulate.preLoginFlow();
      
      const loginResponse = await this.ig.account.login(username, password);
      
      if (loginResponse) {
        this.log('INFO', 'Fresh login successful!');
        
        // Save session
        const session = await this.ig.state.serialize();
        delete session.constants;
        await fs.writeFile(this.paths.session, JSON.stringify(session, null, 2));
        this.log('INFO', 'Session saved successfully');
        
        return true;
      }
      
    } catch (error) {
      this.log('WARN', 'Fresh login failed:', error.message);
      
      // Handle specific errors
      if (error.name === 'IgCheckpointError') {
        this.log('INFO', 'Checkpoint challenge detected');
        const resolved = await this.resolveCheckpoint(error.checkpoint);
        if (resolved) {
          return await this.freshLogin(username, password); // Retry after checkpoint
        }
      } else if (error.name === 'IgLoginTwoFactorRequiredError') {
        this.log('INFO', 'Attempting 2FA bypass...');
        try {
          const twoFactorInfo = error.response.body.two_factor_info;
          
          // Try backup codes if available
          if (twoFactorInfo.backup_codes && twoFactorInfo.backup_codes.length > 0) {
            this.log('INFO', 'Using backup codes for 2FA bypass...');
            // In practice, you'd need to store backup codes
            throw new Error('2FA backup codes required but not implemented');
          }
          
          // Try to skip 2FA
          this.log('INFO', 'Attempting to skip 2FA verification...');
          throw error; // Fall back to normal 2FA if bypass fails
          
        } catch (twoFactorError) {
          this.log('ERROR', '2FA bypass failed:', twoFactorError.message);
          throw error;
        }
      }
      
      throw error;
    }
  }

  // ---------- Login Flow ----------
  // ---------- Login Flow ----------
  async login() {
    const username = config.instagram?.username;
    const password = config.instagram?.password; // optional for fresh login
    const forceFresh = Boolean(config.instagram?.forceFreshLogin);

    if (!username) throw new Error('INSTAGRAM_USERNAME is missing');

    await this.initDevice(username);

    let loginSuccess = false;

    // Restore realtime state if available
    try {
      const statePath = './state.json';
      if (await fs.stat(statePath).catch(() => false)) {
        const stateRaw = await fs.readFile(statePath, 'utf-8');
        await this.ig.importState(stateRaw);
        this.log('INFO', 'Loaded previous realtime state');
      }
    } catch (err) {
      this.log('WARN', 'Failed to load realtime state:', err.message);
    }

    // Force fresh login if requested
    if (forceFresh && password) {
      try {
        this.log('INFO', 'Force fresh login enabled, attempting with credentials...');
        loginSuccess = await this.freshLogin(username, password);
      } catch (error) {
        this.log('WARN', 'Forced fresh login failed:', error.message);
        if (forceFresh) throw error; // Don’t fallback if forced
      }
    }

    if (!loginSuccess && !forceFresh) {
      // 1) Try session.json
      try {
        await fs.access(this.paths.session);
        this.log('INFO', 'Found session.json, attempting session-based login...');
        const sessionData = JSON.parse(await fs.readFile(this.paths.session, 'utf-8'));
        await this.ig.state.deserialize(sessionData);
        await this.ig.account.currentUser();
        this.log('INFO', 'Logged in from session.json');
        loginSuccess = true;
      } catch (sessionError) {
        this.log('WARN', 'Session login failed:', sessionError.message);
      }

      // 2) Try cookies.json
      if (!loginSuccess) {
        try {
          this.log('INFO', 'Attempting login using cookies.json...');
          await this.loadCookiesFromJson(this.paths.cookies);
          const user = await this.ig.account.currentUser();
          this.log('INFO', `Logged in using cookies.json as @${user.username}`);
          const session = await this.ig.state.serialize();
          delete session.constants;
          await fs.writeFile(this.paths.session, JSON.stringify(session, null, 2));
          this.log('INFO', 'Session saved to session.json');
          loginSuccess = true;
        } catch (cookieError) {
          this.log('WARN', 'Cookie login failed:', cookieError.message);
        }
      }

      // 3) Last resort: fresh login if credentials available
      if (!loginSuccess && password) {
        try {
          this.log('INFO', 'Attempting fresh login as last resort...');
          loginSuccess = await this.freshLogin(username, password);
        } catch (freshError) {
          this.log('ERROR', 'All login methods failed:', freshError.message);
          throw new Error(`All login methods failed: ${freshError.message}`);
        }
      }
    }

    if (!loginSuccess) {
      throw new Error('No valid login method succeeded');
    }

    // Warmup: make session look normal before inbox
    try {
      await this.ig.feed.timeline().request();
      await this.ig.account.currentUser();
      await this.delay(2000);
      this.log('INFO', 'Session warmed up with timeline + currentUser');
    } catch (err) {
      this.log('WARN', 'Warmup failed (safe to ignore):', err.message);
    }

    // Register handlers
    this.registerRealtimeHandlers();

    // Try irisData but don’t crash if it fails
    let irisData;
    try {
      irisData = await this.ig.feed.directInbox().request();
      this.log('INFO', 'Fetched initial inbox (irisData) successfully');
    } catch (err) {
      this.log('WARN', 'Failed to fetch irisData, continuing without it:', err.message);
      irisData = undefined;
    }

    // Connect realtime
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
      irisData,
      connectOverrides: {},
      socksOptions: config.proxy ? {
        type: config.proxy.type || 5,
        host: config.proxy.host,
        port: config.proxy.port,
        userId: config.proxy.username,
        password: config.proxy.password,
      } : undefined,
    });

    // Save realtime state for next boot
    try {
      await fs.writeFile('./state.json', await this.ig.exportState(), 'utf-8');
      this.log('INFO', 'Realtime state saved');
    } catch (err) {
      this.log('WARN', 'Failed to save realtime state:', err.message);
    }

    // Foreground simulation
    await this.setForegroundState(true, true, 60);
    this.isRunning = true;
    this.log('INFO', 'Instagram bot is running and listening for messages');
  }

  /**
   * Utility delay function
   * @param {number} ms - Milliseconds to delay
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Loads cookies from a JSON file.
   * @param {string} path - Path to the cookies file.
   * @throws {Error} If loading cookies fails.
   */
  async loadCookiesFromJson(path = './cookies.json') {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const cookies = JSON.parse(raw);
      let cookiesLoaded = 0;

      for (const cookie of cookies) {
        const toughCookie = new tough.Cookie({
          key: cookie.name,
          value: cookie.value,
          domain: cookie.domain.replace(/^\./, ''),
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly !== false,
        });

        await this.ig.state.cookieJar.setCookie(
          toughCookie.toString(),
          `https://${toughCookie.domain}${toughCookie.path}`
        );
        cookiesLoaded++;
      }

      this.log('INFO', `Loaded ${cookiesLoaded}/${cookies.length} cookies`);
    } catch (error) {
      this.log('ERROR', `Failed to load cookies from ${path}:`, error.message);
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
   * Clears authentication data for fresh start
   */
  async clearAuthData() {
    const filesToClear = [this.paths.session, this.paths.cookies, this.paths.device];
    
    for (const filePath of filesToClear) {
      try {
        await fs.unlink(filePath);
        this.log('INFO', `Cleared: ${filePath}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.log('WARN', `Failed to clear ${filePath}:`, error.message);
        }
      }
    }
    
    this.log('INFO', 'Authentication data cleared');
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

    console.log('Bot is running with enhanced login capabilities:');
    console.log('- Persistent device fingerprints');
    console.log('- Checkpoint auto-resolver');
    console.log('- 2FA bypass attempts');
    console.log('- Fresh login support');
    console.log('\nType .help for commands.');

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
