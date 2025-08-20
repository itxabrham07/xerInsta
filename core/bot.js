import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { GraphQLSubscriptions, SkywalkerSubscriptions } from 'instagram_mqtt';
import { promises as fs } from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';

class InstagramBot {
  constructor() {
    this.ig = withRealtime(new IgApiClient());
    this.messageHandlers = [];
    this.isRunning = false;
    this.lastMessageCheck = new Date(Date.now() - 60000);
    this.processedMessageIds = new Set();
    this.maxProcessedMessageIds = 1000;
    this.userCache = new Map();

    this.paths = {
      device: './device.json',
      session: './session.json',
      cookies: './cookies.json',
      state: './state.json',
    };
  }

  log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`, ...args);
  }

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

  async freshLogin(username, password) {
    this.log('INFO', `Attempting fresh login for @${username}...`);
    await this.ig.simulate.preLoginFlow();
    const loginResponse = await this.ig.account.login(username, password);

    if (loginResponse) {
      this.log('INFO', '✅ Fresh login successful');
      const session = await this.ig.state.serialize();
      delete session.constants;
      await fs.writeFile(this.paths.session, JSON.stringify(session, null, 2));
      this.log('INFO', '💾 Session saved to session.json');

      // warmup requests
      try {
        await this.ig.feed.timeline().request();
        await this.ig.account.currentUser();
        await this.delay(2000);
        this.log('INFO', '🔥 Session warmed up after fresh login');
      } catch (e) {
        this.log('WARN', 'Warmup failed (ignored):', e.message);
      }
      return true;
    }
    return false;
  }

  async login() {
    const username = config.instagram?.username;
    const password = config.instagram?.password;
    const forceFresh = Boolean(config.instagram?.forceFreshLogin);

    if (!username) throw new Error('INSTAGRAM_USERNAME is missing');
    await this.initDevice(username);

    let loginSuccess = false;

    // try restoring realtime state
    try {
      if (await fs.stat(this.paths.state).catch(() => false)) {
        const raw = await fs.readFile(this.paths.state, 'utf-8');
        await this.ig.importState(raw);
        this.log('INFO', 'Imported realtime state');
      }
    } catch (e) {
      this.log('WARN', 'No realtime state found:', e.message);
    }

    if (forceFresh && password) {
      loginSuccess = await this.freshLogin(username, password).catch((e) => {
        this.log('WARN', 'Forced fresh login failed:', e.message);
        return false;
      });
    }

    if (!loginSuccess && !forceFresh) {
      // 1) session.json
      try {
        await fs.access(this.paths.session);
        this.log('INFO', 'Found session.json, attempting session-based login...');
        const sessionData = JSON.parse(await fs.readFile(this.paths.session, 'utf-8'));
        await this.ig.state.deserialize(sessionData);
        await this.ig.account.currentUser();
        this.log('INFO', '✅ Logged in from session.json');
        loginSuccess = true;
      } catch (err) {
        this.log('WARN', 'Session login failed:', err.message);
      }

      // 2) cookies.json
      if (!loginSuccess) {
        try {
          this.log('INFO', 'Attempting login using cookies.json...');
          await this.loadCookiesFromJson(this.paths.cookies);
          const user = await this.ig.account.currentUser();
          this.log('INFO', `✅ Logged in with cookies.json as @${user.username}`);
          const session = await this.ig.state.serialize();
          delete session.constants;
          await fs.writeFile(this.paths.session, JSON.stringify(session, null, 2));
          this.log('INFO', '💾 Session saved');
          loginSuccess = true;
        } catch (err) {
          this.log('WARN', 'Cookie login failed:', err.message);
        }
      }

      // 3) fresh login
      if (!loginSuccess && password) {
        loginSuccess = await this.freshLogin(username, password).catch((e) => {
          this.log('ERROR', 'Fresh login failed:', e.message);
          return false;
        });
      }
    }

    if (!loginSuccess) throw new Error('No valid login method succeeded');

    // register realtime handlers
    this.registerRealtimeHandlers();

    // irisData optional
    let irisData;
    try {
      irisData = await this.ig.feed.directInbox().request();
      this.log('INFO', '✅ Inbox (irisData) fetched');
    } catch (e) {
      this.log('WARN', '⚠️ Inbox fetch failed, continuing without irisData:', e.message);
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
      irisData,
    });

    try {
      await fs.writeFile(this.paths.state, await this.ig.exportState(), 'utf-8');
      this.log('INFO', 'Realtime state saved');
    } catch (e) {
      this.log('WARN', 'Failed to save realtime state:', e.message);
    }

    await this.setForegroundState(true, true, 60);
    this.isRunning = true;
    this.log('INFO', '🚀 Instagram bot running & listening for messages');
  }

  async loadCookiesFromJson(path) {
    const raw = await fs.readFile(path, 'utf-8');
    const cookies = JSON.parse(raw);
    let loaded = 0;
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
      loaded++;
    }
    this.log('INFO', `Loaded ${loaded}/${cookies.length} cookies`);
  }

  registerRealtimeHandlers() {
    this.log('INFO', 'Registering realtime handlers...');
    this.ig.realtime.on('message', async (data) => {
      if (!data.message) return;
      if (!this.isNewMessageById(data.message.item_id)) return;
      await this.handleMessage(data.message, data);
    });
    this.ig.realtime.on('direct', async (data) => {
      if (data.message && this.isNewMessageById(data.message.item_id)) {
        await this.handleMessage(data.message, data);
      }
    });
    this.ig.realtime.on('connect', () => {
      this.log('INFO', 'Realtime connected');
      this.isRunning = true;
    });
    this.ig.realtime.on('close', () => {
      this.log('WARN', 'Realtime connection closed');
      this.isRunning = false;
    });
    this.ig.realtime.on('error', (err) => {
      this.log('ERROR', 'Realtime error:', err.message);
    });
  }

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

  async handleMessage(message, eventData) {
    try {
      let senderUsername = `user_${message.user_id}`;
      if (eventData.thread?.users) {
        const sender = eventData.thread.users.find(
          (u) => u.pk?.toString() === message.user_id?.toString()
        );
        if (sender?.username) senderUsername = sender.username;
      }
      const processed = {
        id: message.item_id,
        text: message.text || '',
        senderId: message.user_id,
        senderUsername,
        timestamp: new Date(parseInt(message.timestamp, 10) / 1000),
        threadId: eventData.thread?.thread_id || message.thread_id || 'unknown',
        type: message.item_type || 'unknown',
        raw: message,
      };
      this.log('INFO', `[DM] @${senderUsername}: ${processed.text}`);
      for (const handler of this.messageHandlers) {
        await handler(processed);
      }
    } catch (e) {
      this.log('ERROR', 'Message handler failed:', e.message);
    }
  }

  onMessage(handler) {
    if (typeof handler === 'function') this.messageHandlers.push(handler);
  }

  async sendMessage(threadId, text) {
    await this.ig.entity.directThread(threadId).broadcastText(text);
    this.log('INFO', `Sent message to ${threadId}: "${text}"`);
  }

  async setForegroundState(inApp = true, inDevice = true, timeoutSeconds = 60) {
    try {
      await this.ig.realtime.direct.sendForegroundState({
        inForegroundApp: Boolean(inApp),
        inForegroundDevice: Boolean(inDevice),
        keepAliveTimeout: inApp ? Math.max(10, timeoutSeconds) : 900,
      });
      return true;
    } catch (e) {
      this.log('ERROR', 'Failed to set foreground state:', e.message);
      return false;
    }
  }

  async delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async disconnect() {
    this.log('INFO', 'Disconnecting...');
    this.isRunning = false;
    try {
      await this.setForegroundState(false, false, 900);
      if (this.ig.realtime?.disconnect) await this.ig.realtime.disconnect();
      this.log('INFO', 'Disconnected');
    } catch (e) {
      this.log('WARN', 'Error during disconnect:', e.message);
    }
  }
}

async function main() {
  let bot;
  try {
    bot = new InstagramBot();
    await bot.login();
    const moduleManager = new ModuleManager(bot);
    await moduleManager.loadModules();
    const messageHandler = new MessageHandler(bot, moduleManager, null);
    bot.onMessage((msg) => messageHandler.handleMessage(msg));
    console.log('🚀 Bot running. Type .help for commands.');

    setInterval(() => {
      console.log(`[${new Date().toISOString()}] Bot heartbeat - Running: ${bot.isRunning}`);
    }, 300000);

    const shutdown = async () => {
      console.log('\n👋 Shutting down...');
      if (bot) await bot.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (e) {
    console.error('❌ Bot failed to start:', e.message);
    if (bot) await bot.disconnect();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('Unhandled error:', e.message);
    process.exit(1);
  });
}

export { InstagramBot };
