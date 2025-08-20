import { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';

/**
 * InstagramBot — robust version with enhanced error handling
 * - Persistent device fingerprint (device.json)
 * - Login order: session.json -> cookies.json -> fresh username/password
 * - Optional 2FA support (reads config.instagram.twoFactorCode or TOTP via config.instagram.totpSecret if otplib is available)
 * - Realtime reconnect with backoff
 * - Human-like jitter for heartbeats & foreground state
 * - Enhanced error handling for API issues
 */
class InstagramBot {
  constructor(options = {}) {
    this.ig = withRealtime(new IgApiClient());
    this.messageHandlers = [];
    this.isRunning = false;
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
    this.userCache = new Map();

    this.paths = {
      device: options.devicePath || './device.json',
      session: options.sessionPath || './session.json',
      cookies: options.cookiesPath || './cookies.json',
    };

    this.heartbeatTimer = null;
    this.foregroundTimer = null;
    this.reconnectAttempt = 0;
    this.maxReconnectAttempts = 10;
    this.realtimeConnected = false;
  }

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
  async login() {
    const username = config.instagram?.username;
    const password = config.instagram?.password; // optional for fresh login
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
      await this.saveSession();
    } catch (err) {
      // 2FA flow
      if (err instanceof IgLoginTwoFactorRequiredError || err?.name === 'IgLoginTwoFactorRequiredError') {
        await this.handleTwoFactorLogin(err, username, password);
        return;
      }

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

      throw err; // bubble up if not handled
    }
  }

  async handleTwoFactorLogin(error, username, password) {
    const { two_factor_info: info } = error;
    const identifier = info?.two_factor_identifier;
    const totp = info?.totp_two_factor_on; // if true, authenticator app is allowed

    if (!identifier) throw new Error('2FA required but no identifier provided by Instagram.');

    let code = (config.instagram?.twoFactorCode || '').toString().trim();

    // If no static code, try TOTP via otplib if totp is enabled and secret is provided
    if (!code && totp && config.instagram?.totpSecret) {
      try {
        const { totp: totpGen } = await import('otplib');
        code = totpGen.generate(config.instagram.totpSecret);
        this.log('INFO', 'Generated TOTP code via otplib.');
      } catch {
        this.log('WARN', 'otplib not installed; cannot auto-generate TOTP. Provide instagram.twoFactorCode or install otplib.');
      }
    }

    if (!code) throw new Error('2FA code required. Set config.instagram.twoFactorCode or instagram.totpSecret (+ otplib).');

    const method = totp ? '0' : String(info?.sms_two_factor_on ? 1 : 0);

    await this.ig.account.twoFactorLogin({
      username,
      password,
      twoFactorIdentifier: identifier,
      verificationCode: code,
      verificationMethod: method, // '0' = TOTP/app, '1' = SMS
      trustThisDevice: true,
    });

    this.log('INFO', '2FA login successful.');
    await this.saveSession();
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

  // ---------- Realtime ----------
  async postLogin() {
    this.registerRealtimeHandlers();
    
    // Add delay after fresh login to avoid rate limiting
    this.log('INFO', 'Waiting before connecting to realtime...');
    await this.sleep(this.rand(3000, 8000));
    
    await this.connectRealtime();

    // Initial foreground presence only if realtime is connected
    if (this.realtimeConnected) {
      await this.setForegroundState(true, true, 60 + this.rand(-10, 10));
      this.isRunning = true;

      // Start jittered tasks
      this.scheduleHeartbeat();
      this.scheduleForegroundCycles();
    }
  }

  async connectRealtime() {
    const maxRetries = 5;
    let attempt = 0;

    while (attempt < maxRetries && !this.realtimeConnected) {
      try {
        attempt++;
        this.log('INFO', `Attempting realtime connection (${attempt}/${maxRetries})...`);

        const socksOptions = config.proxy
          ? {
              type: config.proxy.type || 5,
              host: config.proxy.host,
              port: config.proxy.port,
              userId: config.proxy.username,
              password: config.proxy.password,
            }
          : undefined;

        // Try to get inbox data with retries and fallback
        let irisData = null;
        try {
          // Add delay before fetching inbox
          await this.sleep(this.rand(2000, 5000));
          irisData = await this.getInboxDataWithRetry();
        } catch (inboxError) {
          this.log('WARN', `Failed to get inbox data: ${inboxError.message}. Proceeding without iris data.`);
          // Continue without iris data - realtime can still work
        }

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
          irisData, // This can be null if inbox fetch failed
          connectOverrides: {},
          socksOptions,
        });

        this.realtimeConnected = true;
        this.log('INFO', 'Realtime connection established successfully');
        return;

      } catch (error) {
        this.log('ERROR', `Realtime connection attempt ${attempt} failed: ${error.message}`);
        
        if (attempt < maxRetries) {
          const delay = Math.min(30000, 5000 * Math.pow(2, attempt - 1));
          this.log('INFO', `Retrying in ${delay / 1000}s...`);
          await this.sleep(delay);
        }
      }
    }

    if (!this.realtimeConnected) {
      this.log('WARN', 'Failed to establish realtime connection after all attempts. Bot will continue without realtime features.');
      // Don't throw error, allow bot to continue in polling mode if needed
    }
  }

  async getInboxDataWithRetry(maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        if (i > 0) {
          const delay = 1000 * Math.pow(2, i);
          this.log('INFO', `Retrying inbox fetch in ${delay / 1000}s...`);
          await this.sleep(delay);
        }

        // Try different inbox fetch approaches
        const inboxFeed = this.ig.feed.directInbox();
        
        // Set more conservative parameters
        inboxFeed.limit = 10; // Reduce limit
        
        const result = await inboxFeed.request();
        this.log('INFO', 'Successfully fetched inbox data');
        return result;
        
      } catch (error) {
        lastError = error;
        this.log('WARN', `Inbox fetch attempt ${i + 1} failed: ${error.message}`);
        
        // If it's a 500 error, wait longer between retries
        if (error.message.includes('500')) {
          await this.sleep(this.rand(5000, 10000));
        }
      }
    }
    
    throw lastError;
  }

  registerRealtimeHandlers() {
    this.log('INFO', 'Registering realtime handlers...');

    this.ig.realtime.on('message', async (data) => {
      try {
        if (!data?.message) return;
        const id = data.message.item_id;
        if (!this.isNewMessageById(id)) return;
        await this.handleMessage(data.message, data);
      } catch (e) {
        this.log('ERROR', `Realtime message handler error: ${e?.message || e}`);
      }
    });

    this.ig.realtime.on('direct', async (data) => {
      try {
        if (data?.message && this.isNewMessageById(data.message.item_id)) {
          await this.handleMessage(data.message, data);
        }
      } catch (e) {
        this.log('ERROR', `Realtime direct handler error: ${e?.message || e}`);
      }
    });

    this.ig.realtime.on('receive', (topic, messages) => {
      const t = String(topic || '');
      if (t.includes('direct') || t.includes('message') || t.includes('iris')) {
        this.log('DEBUG', `Received on topic: ${t}`, JSON.stringify(messages, null, 2));
      }
    });

    this.ig.realtime.on('connect', () => {
      this.log('INFO', 'Realtime connected');
      this.isRunning = true;
      this.realtimeConnected = true;
      this.reconnectAttempt = 0; // reset backoff
    });

    this.ig.realtime.on('close', async () => {
      this.log('WARN', 'Realtime connection closed');
      this.isRunning = false;
      this.realtimeConnected = false;
      await this.scheduleReconnect();
    });

    this.ig.realtime.on('error', async (err) => {
      this.log('ERROR', `Realtime error: ${err?.message || err}`);
      this.realtimeConnected = false;
      await this.scheduleReconnect();
    });

    this.ig.realtime.on('reconnect', () => {
      this.log('INFO', 'Realtime reconnect event emitted');
    });
  }

  async scheduleReconnect() {
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.log('ERROR', `Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stopping reconnection attempts.`);
      return;
    }

    // Exponential backoff with jitter: base 2s up to ~60s
    const base = Math.min(60000, 2000 * Math.pow(2, this.reconnectAttempt));
    const delay = this.jitter(base, 0.2);
    this.reconnectAttempt++;
    this.log('INFO', `Scheduling reconnect in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempt})`);
    
    await this.sleep(delay);
    
    try {
      await this.connectRealtime();
    } catch (e) {
      this.log('ERROR', `Reconnect failed: ${e?.message || e}`);
      // try again later
      await this.scheduleReconnect();
    }
  }

  // ---------- Messaging ----------
  isNewMessageById(messageId) {
    if (!messageId) return true;
    if (this.processedMessageIds.has(messageId)) return false;
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > this.maxProcessedMessageIds) {
      const first = this.processedMessageIds.values().next().value;
      this.processedMessageIds.delete(first);
    }
    return true;
  }

  async getUsername(userId) {
    if (!userId) return `user_${userId || 'unknown'}`;
    if (this.userCache.has(userId)) return this.userCache.get(userId);
    try {
      const userInfo = await this.ig.user.info(userId);
      const username = userInfo.username || `user_${userId}`;
      this.userCache.set(userId, username);
      this.log('DEBUG', `Fetched username ${username} for user ID ${userId}`);
      return username;
    } catch (error) {
      this.log('ERROR', `Failed to fetch username for user ID ${userId}: ${error?.message || error}`);
      return `user_${userId}`;
    }
  }

  async handleMessage(message, eventData) {
    try {
      if (!message || !message.user_id || !message.item_id) {
        this.log('WARN', 'Received malformed message');
        return;
      }

      let senderUsername = `user_${message.user_id}`;
      if (eventData?.thread?.users) {
        const sender = eventData.thread.users.find((u) => u.pk?.toString() === message.user_id?.toString());
        senderUsername = sender?.username || (await this.getUsername(message.user_id));
      } else {
        senderUsername = await this.getUsername(message.user_id);
      }

      const processedMessage = {
        id: message.item_id,
        text: message.text || '',
        senderId: message.user_id,
        senderUsername,
        timestamp: new Date(parseInt(message.timestamp, 10) / 1000),
        threadId: eventData?.thread?.thread_id || message.thread_id || 'unknown_thread',
        threadTitle: eventData?.thread?.thread_title || message.thread_title || 'Direct Message',
        type: message.item_type || 'unknown_type',
        raw: message,
      };

      this.log('INFO', `[${processedMessage.threadTitle}] New message from @${processedMessage.senderUsername}: "${processedMessage.text}"`);

      for (const handler of this.messageHandlers) {
        await handler(processedMessage);
      }
    } catch (error) {
      this.log('ERROR', `Error handling message: ${error?.message || error}`);
    }
  }

  onMessage(handler) {
    if (typeof handler === 'function') {
      this.messageHandlers.push(handler);
      this.log('INFO', `Added message handler (total: ${this.messageHandlers.length})`);
    } else {
      this.log('WARN', 'Attempted to add non-function message handler');
    }
  }

  async sendMessage(threadId, text) {
    if (!threadId || !text) throw new Error('Thread ID and text are required');
    await this.sleep(this.rand(300, 1500)); // small human-like delay
    await this.ig.entity.directThread(threadId).broadcastText(text);
    this.log('INFO', `Text message sent to thread ${threadId}: "${text}"`);
    return true;
  }

  // ---------- Foreground / Presence Simulation ----------
  async setForegroundState(inApp = true, inDevice = true, timeoutSeconds = 60) {
    if (!this.realtimeConnected || !this.ig.realtime?.direct?.sendForegroundState) {
      this.log('WARN', 'Cannot set foreground state: realtime not connected or method unavailable');
      return false;
    }

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
      this.log('ERROR', `Failed to set foreground state: ${error?.message || error}`);
      return false;
    }
  }

  scheduleForegroundCycles() {
    if (!this.realtimeConnected) {
      this.log('WARN', 'Skipping foreground cycles: realtime not connected');
      return;
    }

    // Simulate user sometimes backgrounding the app
    const runCycle = async () => {
      if (!this.realtimeConnected || !this.isRunning) return;
      
      // App goes background for 5–20 min
      await this.setForegroundState(false, false, 900);
      await this.sleep(this.rand(5 * 60_000, 20 * 60_000));
      
      if (!this.realtimeConnected || !this.isRunning) return;
      
      // Back to foreground for 1–10 min
      await this.setForegroundState(true, true, 60 + this.rand(-10, 10));
      await this.sleep(this.rand(1 * 60_000, 10 * 60_000));
      
      if (this.isRunning) {
        this.foregroundTimer = setTimeout(runCycle, this.rand(15 * 60_000, 60 * 60_000));
      }
    };

    // start after a short random delay
    this.foregroundTimer = setTimeout(runCycle, this.rand(60_000, 5 * 60_000));
  }

  // ---------- Heartbeat ----------
  scheduleHeartbeat() {
    const run = () => {
      if (!this.isRunning) return;
      
      this.log('INFO', `[Heartbeat] Running: ${this.isRunning}, Realtime: ${this.realtimeConnected}`);
      const next = this.jitter(5 * 60_000, 0.4); // ~5min ±40%
      
      if (this.isRunning) {
        this.heartbeatTimer = setTimeout(run, next);
      }
    };
    const first = this.jitter(2 * 60_000, 0.5); // first after ~2min ±50%
    this.heartbeatTimer = setTimeout(run, first);
  }

  // ---------- Graceful Disconnect ----------
  async disconnect() {
    this.log('INFO', 'Initiating graceful disconnect...');
    this.isRunning = false;

    try {
      if (this.realtimeConnected) {
        await this.setForegroundState(false, false, 900);
      }
    } catch (error) {
      this.log('WARN', `Error setting background state: ${error?.message || error}`);
    }

    try {
      if (this.ig.realtime?.disconnect) {
        await this.ig.realtime.disconnect();
        this.log('INFO', 'Disconnected from Instagram realtime');
        this.realtimeConnected = false;
      }
    } catch (error) {
      this.log('WARN', `Error during disconnect: ${error?.message || error}`);
    }

    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.foregroundTimer) clearTimeout(this.foregroundTimer);
  }

  // ---------- Utils ----------
  rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  jitter(baseMs, fraction = 0.2) {
    const delta = baseMs * fraction;
    return Math.floor(baseMs - delta + Math.random() * (2 * delta));
  }

  sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
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

    const shutdownHandler = async () => {
      console.log('\n[SIGINT/SIGTERM] Shutting down gracefully...');
      if (bot) await bot.disconnect();
      console.log('Shutdown complete.');
      process.exit(0);
    };

    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);
  } catch (error) {
    console.error('Bot failed to start:', error?.message || error);
    if (bot) await bot.disconnect();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Unhandled error in main:', error?.message || error);
    process.exit(1);
  });
}

export { InstagramBot };
