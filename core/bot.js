
import { IgApiClient } from 'instagram-private-api';
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
   * Logs in to Instagram using session or cookies.
   * @throws {Error} If login fails due to missing credentials or invalid session/cookies.
   */
  async login() {
    try {
      const username = config.instagram?.username;
      if (!username) {
        throw new Error('INSTAGRAM_USERNAME is missing');
      }

      this.ig.state.generateDevice(username); // Simulates mobile device
      let loginSuccess = false;

      // Attempt login with session
      try {
        await fs.access('./session.json');
        this.log('INFO', 'Found session.json, attempting session-based login...');
        const sessionData = JSON.parse(await fs.readFile('./session.json', 'utf-8'));
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
          await this.loadCookiesFromJson('./cookies.json');
          const user = await this.ig.account.currentUser();
          this.log('INFO', `Logged in using cookies.json as @${user.username}`);
          const session = await this.ig.state.serialize();
          delete session.constants;
          await fs.writeFile('./session.json', JSON.stringify(session, null, 2));
          this.log('INFO', 'Session saved to session.json');
          loginSuccess = true;
        } catch (cookieError) {
          this.log('ERROR', 'Failed to login with cookies:', cookieError.message);
          throw new Error(`Cookie login failed: ${cookieError.message}`);
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
        this.log('INFO', 'Received non-message direct event');
      }
    });

    // Handle thread updates for message requests if autoApprove is enabled
    if (config.messageRequests?.autoApprove) {
      this.ig.realtime.on('threadUpdate', async (data) => {
        try {
          if (data.update?.pending) {
            this.log('INFO', `New message request detected in thread ${data.update.thread_id || data.update.thread_v2_id}`);
            await this.handleMessageRequest(data.update);
          }
        } catch (error) {
          this.log('ERROR', 'Error handling thread update:', error.message);
        }
      });
    } else {
      this.log('INFO', 'Message request auto-approval disabled in config');
    }

    // General receive event for debugging
    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message') || topicStr.includes('iris')) {
        this.log('DEBUG', `Received on topic: ${topicStr}`);
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
        if (sender?.username) senderUsername = sender.username;
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
   * Handles new message requests with simple auto-approval logic.
   * @param {object} threadUpdate - The thread update data.
   */
  async handleMessageRequest(threadUpdate) {
    try {
      if (!threadUpdate.thread_id && !threadUpdate.thread_v2_id) {
        this.log('WARN', 'Received malformed thread update for message request');
        return;
      }

      const threadId = threadUpdate.thread_id || threadUpdate.thread_v2_id;
      const senderUsername = threadUpdate.users?.[0]?.username || 'unknown';

      if (config.messageRequests?.autoApprove) {
        await this.approveMessageRequest(threadId);
        await this.sendMessage(threadId, 'Your message request has been approved.');
        this.log('INFO', `Auto-approved message request from @${senderUsername} in thread ${threadId}`);
      } else {
        this.log('INFO', `Message request from @${senderUsername} in thread ${threadId} not auto-approved (config disabled)`);
      }
    } catch (error) {
      this.log('ERROR', 'Error handling message request:', error.message);
    }
  }

  /**
   * Sends an audio message to a thread, simulating a mobile-recorded voice message.
   * @param {string} threadId - The thread ID.
   * @param {string|Buffer} audio - Path to the audio file or Buffer containing audio data.
   * @returns {boolean} True if sent successfully.
   */
  async sendAudioMessage(threadId, audio) {
    if (!threadId || !audio) {
      this.log('WARN', 'Missing threadId or audio data');
      throw new Error('Thread ID and audio data are required');
    }
    try {
      let audioBuffer;
      if (typeof audio === 'string') {
        this.log('INFO', `Reading audio file from ${audio}`);
        audioBuffer = await fs.readFile(audio);
      } else if (Buffer.isBuffer(audio)) {
        audioBuffer = audio;
      } else {
        throw new Error('Audio must be a file path or Buffer');
      }

      // Validate audio format (basic check for size and extension if file path)
      if (typeof audio === 'string') {
        const validExtensions = ['.mp3', '.m4a', '.wav'];
        if (!validExtensions.some(ext => audio.toLowerCase().endsWith(ext))) {
          throw new Error('Unsupported audio format. Use MP3, M4A, or WAV.');
        }
        if (audioBuffer.length > 10 * 1024 * 1024) { // 10MB limit
          throw new Error('Audio file exceeds 10MB limit');
        }
      }

      // Simulate mobile metadata if enabled
      const options = config.audioMessages?.simulateMobile
        ? { device_id: this.ig.state.deviceId, is_voice: true }
        : {};

      await this.ig.entity.directThread(threadId).broadcastVoice(audioBuffer, options);
      this.log('INFO', `Audio message sent to thread ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `Error sending audio message to thread ${threadId}:`, error.message);
      throw error;
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
   * Approves a message request.
   * @param {string} threadId - The thread ID.
   * @returns {boolean} True if approved successfully.
   */
  async approveMessageRequest(threadId) {
    if (!threadId) {
      this.log('WARN', 'Missing threadId for approveMessageRequest');
      return false;
    }
    try {
      await this.ig.directThread.approve(threadId);
      this.log('INFO', `Approved message request: ${threadId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `Failed to approve message request ${threadId}:`, error.message);
      return false;
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
   * Subscribes to live comments for a broadcast.
   * @param {string} broadcastId - The broadcast ID.
   * @returns {boolean} True if subscription is successful.
   */
  async subscribeToLiveComments(broadcastId) {
    if (!broadcastId) {
      this.log('WARN', 'Missing broadcastId');
      return false;
    }
    try {
      await this.ig.realtime.graphQlSubscribe(
        GraphQLSubscriptions.getLiveRealtimeCommentsSubscription(broadcastId)
      );
      this.log('INFO', `Subscribed to live comments for broadcast: ${broadcastId}`);
      return true;
    } catch (error) {
      this.log('ERROR', `Failed to subscribe to live comments: ${broadcastId}`, error.message);
      return false;
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

    // Example: Send an audio message to a thread (replace with actual threadId and audio file)
    // await bot.sendAudioMessage('thread_id_here', './path/to/audio.mp3');

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
