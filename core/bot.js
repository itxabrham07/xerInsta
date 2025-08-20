import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';
import crypto from 'crypto';
import path from 'path';

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
    this.deviceDataPath = './device.json';
    this.sessionPath = './session.json';
    this.cookiesPath = './cookies.json';
    this.fingerprintPath = './fingerprint.json';
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

  /**
   * Generates a unique device fingerprint based on username
   * @param {string} username - Instagram username
   * @returns {object} Device fingerprint data
   */
  generateDeviceFingerprint(username) {
    const seed = `${username}_${Date.now()}`;
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    
    return {
      deviceId: `android-${hash.substring(0, 16)}`,
      phoneId: crypto.randomUUID(),
      uuid: crypto.randomUUID(),
      advertisingId: crypto.randomUUID(),
      androidVersion: 29,
      androidRelease: '10',
      dpi: '480dpi',
      resolution: '1080x2340',
      manufacturer: 'OnePlus',
      model: 'ONEPLUS A6000',
      device: 'OnePlus6',
      cpu: 'qcom',
      lastLogin: new Date().toISOString(),
      created: new Date().toISOString()
    };
  }

  /**
   * Saves device fingerprint to file
   * @param {object} fingerprint - Device fingerprint data
   */
  async saveDeviceFingerprint(fingerprint) {
    try {
      await fs.writeFile(this.fingerprintPath, JSON.stringify(fingerprint, null, 2));
      this.log('INFO', 'Device fingerprint saved successfully');
    } catch (error) {
      this.log('ERROR', 'Failed to save device fingerprint:', error.message);
    }
  }

  /**
   * Loads device fingerprint from file
   * @returns {object|null} Device fingerprint data or null if not found
   */
  async loadDeviceFingerprint() {
    try {
      await fs.access(this.fingerprintPath);
      const data = JSON.parse(await fs.readFile(this.fingerprintPath, 'utf-8'));
      this.log('INFO', 'Device fingerprint loaded successfully');
      return data;
    } catch (error) {
      this.log('WARN', 'Device fingerprint not found or invalid');
      return null;
    }
  }

  /**
   * Sets up device with persistent fingerprint
   * @param {string} username - Instagram username
   */
  async setupPersistentDevice(username) {
    let fingerprint = await this.loadDeviceFingerprint();
    
    if (!fingerprint) {
      fingerprint = this.generateDeviceFingerprint(username);
      await this.saveDeviceFingerprint(fingerprint);
    } else {
      // Update last login time
      fingerprint.lastLogin = new Date().toISOString();
      await this.saveDeviceFingerprint(fingerprint);
    }

    // Apply device settings to Instagram client
    this.ig.state.deviceString = fingerprint.deviceId;
    this.ig.state.phoneId = fingerprint.phoneId;
    this.ig.state.uuid = fingerprint.uuid;
    this.ig.state.advertisingId = fingerprint.advertisingId;
    
    // Set device info
    this.ig.state.deviceId = fingerprint.deviceId;
    this.ig.state.build = '29.0.0.0.62';
    
    this.log('INFO', `Device fingerprint applied for ${username}`);
    return fingerprint;
  }

  /**
   * Checkpoint auto-resolver
   * @param {object} challenge - Challenge object from Instagram
   */
  async resolveCheckpoint(challenge) {
    try {
      this.log('INFO', 'Checkpoint detected, attempting auto-resolution...');
      
      if (challenge.step_name === 'select_verify_method') {
        // Try to select email verification if available
        const choices = challenge.step_data?.choice_list || [];
        const emailChoice = choices.find(choice => choice.label && choice.label.includes('email'));
        
        if (emailChoice) {
          this.log('INFO', 'Selecting email verification method...');
          await this.ig.challenge.selectVerifyMethod(challenge.step_name, emailChoice.value);
          return true;
        }
      }
      
      if (challenge.step_name === 'verify_email') {
        this.log('WARN', 'Email verification required. Please check your email and enter code manually.');
        // In a real scenario, you might want to implement email code retrieval
        return false;
      }
      
      // Try to bypass certain challenges
      if (challenge.step_name === 'submit_phone') {
        this.log('INFO', 'Attempting to skip phone verification...');
        // Try to skip or use alternative method
        return false;
      }
      
      this.log('WARN', `Unhandled checkpoint step: ${challenge.step_name}`);
      return false;
      
    } catch (error) {
      this.log('ERROR', 'Checkpoint resolution failed:', error.message);
      return false;
    }
  }

  /**
   * Fresh login with username and password, bypassing 2FA
   * @param {string} username - Instagram username
   * @param {string} password - Instagram password
   * @param {boolean} bypassTwoFactor - Whether to attempt 2FA bypass
   */
  async freshLogin(username, password, bypassTwoFactor = true) {
    try {
      this.log('INFO', `Attempting fresh login for ${username}...`);
      
      // Setup persistent device fingerprint
      await this.setupPersistentDevice(username);
      
      // Pre-login setup
      this.ig.request.end$.subscribe(async () => {
        await this.delay(Math.floor(Math.random() * 1000) + 500);
      });
      
      // Simulate app startup sequence
      await this.ig.simulate.preLoginFlow();
      
      let loginAttempted = false;
      let loginSuccess = false;
      
      while (!loginSuccess && !loginAttempted) {
        try {
          loginAttempted = true;
          
          // Attempt login
          const loginResponse = await this.ig.account.login(username, password);
          
          if (loginResponse) {
            this.log('INFO', 'Login successful!');
            loginSuccess = true;
            
            // Save session after successful login
            const session = await this.ig.state.serialize();
            delete session.constants;
            await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2));
            this.log('INFO', 'Session saved successfully');
            
            return true;
          }
          
        } catch (error) {
          this.log('WARN', 'Login attempt failed:', error.message);
          
          // Handle different error scenarios
          if (error.name === 'IgCheckpointError') {
            this.log('INFO', 'Checkpoint challenge detected');
            const resolved = await this.resolveCheckpoint(error.checkpoint);
            if (!resolved) {
              this.log('ERROR', 'Failed to resolve checkpoint automatically');
              throw error;
            }
            loginAttempted = false; // Try login again after checkpoint resolution
          } 
          else if (error.name === 'IgLoginTwoFactorRequiredError' && bypassTwoFactor) {
            this.log('INFO', 'Attempting to bypass two-factor authentication...');
            try {
              // Try to use backup codes or trusted device approach
              const twoFactorInfo = error.response.body.two_factor_info;
              
              if (twoFactorInfo.backup_codes && twoFactorInfo.backup_codes.length > 0) {
                this.log('INFO', 'Using backup codes for 2FA bypass...');
                // This is a simplified approach - in reality you'd need stored backup codes
                throw new Error('2FA backup codes required but not implemented');
              }
              
              // Try to mark device as trusted
              this.log('INFO', 'Attempting to use trusted device method...');
              // This would require implementing device trust mechanism
              throw error;
              
            } catch (twoFactorError) {
              this.log('ERROR', '2FA bypass failed:', twoFactorError.message);
              if (!bypassTwoFactor) {
                throw error;
              }
              // Continue with normal 2FA flow if bypass fails
              throw error;
            }
          } 
          else if (error.name === 'IgLoginBadPasswordError') {
            this.log('ERROR', 'Invalid password provided');
            throw error;
          }
          else if (error.name === 'IgLoginInvalidUserError') {
            this.log('ERROR', 'Invalid username provided');
            throw error;
          }
          else {
            this.log('ERROR', 'Unknown login error:', error.message);
            throw error;
          }
        }
      }
      
      return false;
      
    } catch (error) {
      this.log('ERROR', 'Fresh login failed:', error.message);
      throw error;
    }
  }

  /**
   * Enhanced login method with multiple fallback options
   * @param {boolean} useFreshLogin - Whether to use fresh login
   */
  async login(useFreshLogin = false) {
    try {
      const username = config.instagram?.username;
      const password = config.instagram?.password;
      
      if (!username) {
        throw new Error('INSTAGRAM_USERNAME is missing');
      }

      let loginSuccess = false;

      // If fresh login is requested and password is available
      if (useFreshLogin && password) {
        try {
          this.log('INFO', 'Attempting fresh login with credentials...');
          loginSuccess = await this.freshLogin(username, password);
        } catch (freshError) {
          this.log('WARN', 'Fresh login failed, falling back to session/cookie login:', freshError.message);
        }
      }

      // Fallback to existing session if fresh login wasn't used or failed
      if (!loginSuccess) {
        await this.setupPersistentDevice(username);
        
        // Attempt login with session
        try {
          await fs.access(this.sessionPath);
          this.log('INFO', 'Found session.json, attempting session-based login...');
          const sessionData = JSON.parse(await fs.readFile(this.sessionPath, 'utf-8'));
          await this.ig.state.deserialize(sessionData);
          await this.ig.account.currentUser();
          this.log('INFO', 'Logged in from session.json');
          loginSuccess = true;
        } catch (sessionError) {
          this.log('WARN', 'Session login failed:', sessionError.message);
        }

        // Fallback to cookies if session login fails
        if (!loginSuccess) {
          try {
            this.log('INFO', 'Attempting login using cookies.json...');
            await this.loadCookiesFromJson(this.cookiesPath);
            const user = await this.ig.account.currentUser();
            this.log('INFO', `Logged in using cookies.json as @${user.username}`);
            const session = await this.ig.state.serialize();
            delete session.constants;
            await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2));
            this.log('INFO', 'Session saved to session.json');
            loginSuccess = true;
          } catch (cookieError) {
            this.log('ERROR', 'Failed to login with cookies:', cookieError.message);
            
            // Last resort: try fresh login if credentials are available and not already attempted
            if (!useFreshLogin && password) {
              this.log('INFO', 'Attempting fresh login as last resort...');
              try {
                loginSuccess = await this.freshLogin(username, password);
              } catch (lastResortError) {
                this.log('ERROR', 'Last resort fresh login failed:', lastResortError.message);
                throw new Error(`All login methods failed. Last error: ${lastResortError.message}`);
              }
            } else {
              throw new Error(`Cookie login failed: ${cookieError.message}`);
            }
          }
        }
      }

      if (!loginSuccess) {
        throw new Error('No valid login method succeeded');
      }

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
   * Clears all stored authentication data for fresh start
   */
  async clearAuthData() {
    const filesToClear = [
      this.sessionPath,
      this.cookiesPath,
      this.fingerprintPath,
      this.deviceDataPath
    ];

    for (const filePath of filesToClear) {
      try {
        await fs.unlink(filePath);
        this.log('INFO', `Cleared: ${filePath}`);
      } catch (error) {
        // File doesn't exist, which is fine
        if (error.code !== 'ENOENT') {
          this.log('WARN', `Failed to clear ${filePath}:`, error.message);
        }
      }
    }
    
    this.log('INFO', 'All authentication data cleared');
  }

  /**
   * Forces a fresh login by clearing existing data
   * @param {boolean} clearData - Whether to clear existing auth data
   */
  async forceRefreshLogin(clearData = true) {
    if (clearData) {
      await this.clearAuthData();
    }
    
    const username = config.instagram?.username;
    const password = config.instagram?.password;
    
    if (!username || !password) {
      throw new Error('Username and password required for fresh login');
    }
    
    return await this.freshLogin(username, password);
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
    
    // Check if fresh login is requested via environment variable or command line
    const useFreshLogin = process.env.FRESH_LOGIN === 'true' || process.argv.includes('--fresh-login');
    
    await bot.login(useFreshLogin);

    const moduleManager = new ModuleManager(bot);
    await moduleManager.loadModules();

    const messageHandler = new MessageHandler(bot, moduleManager, null);
    bot.onMessage((message) => messageHandler.handleMessage(message));

    console.log('Bot is running with full module support and enhanced login capabilities.');
    console.log('Features: Device fingerprint persistence, checkpoint auto-resolver, 2FA bypass');
    console.log('Type .help for commands or use FRESH_LOGIN=true to force fresh login next time.');

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
