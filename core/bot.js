import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import fs from 'fs';
import tough from 'tough-cookie';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';

class InstagramBot {
  constructor() {
    this.ig = withRealtime(new IgApiClient());
    this.messageHandlers = [];
    this.isRunning = false;
    this.lastMessageCheck = new Date(Date.now() - 60000); // Start 1 minute ago
  }

  log(level, message, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${level}] ${message}`, ...args);
  }

async login() {
  try {
    const username = config.instagram?.username;
    const password = config.instagram?.password;

    if (!username) throw new Error('❌ INSTAGRAM_USERNAME is missing');

    this.ig.state.generateDevice(username);

    let loggedIn = false;

    // Try session.json first
    try {
      await fs.promises.access('./session.json');
      this.log('INFO', '📂 Found session.json, trying to login from session...');
      const sessionData = JSON.parse(await fs.promises.readFile('./session.json', 'utf-8'));
      await this.ig.state.deserialize(sessionData);
      await this.ig.account.currentUser(); // Validate session
      this.log('INFO', '✅ Logged in from session.json');
      loggedIn = true;
    } catch (err) {
      this.log('WARN', '⚠️ session.json not found or invalid:', err.message);
    }

    // Fallback to cookies.json
    if (!loggedIn) {
      try {
        this.log('INFO', '📂 Trying cookies.json...');
        await this.loadCookiesFromJson('./cookies.json');
        await this.ig.account.currentUser(); // Validate session
        this.log('INFO', '✅ Logged in using cookies.json');

        // Save session for next time
        const session = await this.ig.state.serialize();
        delete session.constants;
        await fs.promises.writeFile('./session.json', JSON.stringify(session, null, 2));
        this.log('INFO', '💾 session.json saved from cookie-based login');
        loggedIn = true;
      } catch (err) {
        this.log('ERROR', '❌ Failed to login via cookies:', err.message);
      }
    }

    // Fallback to fresh login
    if (!loggedIn && config.instagram.allowFreshLogin !== false) {
      this.log('INFO', '🔄 Performing fresh login...');
      await this.ig.account.login(username, password);
      this.log('INFO', '✅ Fresh login successful');

      // Save session
      const session = await this.ig.state.serialize();
      delete session.constants;
      await fs.promises.writeFile('./session.json', JSON.stringify(session, null, 2));
      this.log('INFO', '💾 session.json saved after fresh login');
    } else if (!loggedIn) {
      throw new Error('🚫 No valid session or cookies, and fresh login disabled.');
    }

    // Register handlers
    this.registerRealtimeHandlers();

    // Connect to realtime
    await this.ig.realtime.connect({
      irisData: await this.ig.feed.directInbox().request(),
    });

    const user = await this.ig.account.currentUser();
    this.log('INFO', `✅ Connected as @${user.username} (ID: ${user.pk})`);

    this.isRunning = true;
    this.log('INFO', '🚀 Instagram bot is now running and listening for messages');

  } catch (error) {
    this.log('ERROR', '❌ Failed to initialize bot:', error.message);
    throw error;
  }
}
async loadCookiesFromJson(path = './cookies.json') {
  try {
    const raw = await fs.promises.readFile(path, 'utf-8');
    const cookies = JSON.parse(raw);

    for (const cookie of cookies) {
      const toughCookie = new tough.Cookie({
        key: cookie.name,
        value: cookie.value,
        domain: cookie.domain.replace(/^\./, ''), // Remove leading dot
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly !== false,
        expires: cookie.expirationDate ? new Date(cookie.expirationDate * 1000) : undefined,
      });

      const cookieStr = toughCookie.toString();
      const url = `https://${toughCookie.domain}${toughCookie.path}`;
      await this.ig.state.cookieJar.setCookie(cookieStr, url);
    }

    this.log('INFO', `🍪 Loaded ${cookies.length} cookies from file`);
  } catch (error) {
    this.log('ERROR', '❌ Error loading cookies:', error.message);
    throw error;
  }
}

  registerRealtimeHandlers() {
    this.log('INFO', '📡 Registering real-time event handlers...');

    // Main message handler - this is the key one for direct messages
    this.ig.realtime.on('message', async (data) => {
      try {
        this.log('INFO', '📨 [Realtime] Message event received');
        
        if (!data.message) {
          this.log('WARN', '⚠️ No message in event data');
          return;
        }

        if (!this.isNewMessage(data.message)) {
          this.log('WARN', '⚠️ Message filtered as old');
          return;
        }

        this.log('INFO', '✅ Processing new message...');
        await this.handleMessage(data.message, data);

      } catch (err) {
        this.log('ERROR', '❌ Error in message handler:', err.message);
      }
    });

    // Direct events handler
    this.ig.realtime.on('direct', async (data) => {
      try {
        this.log('INFO', '📨 [Realtime] Direct event received');
        
        if (data.message) {
          if (!this.isNewMessage(data.message)) {
            this.log('WARN', '⚠️ Direct message filtered as old');
            return;
          }

          this.log('INFO', '✅ Processing new direct message...');
          await this.handleMessage(data.message, data);
        }

      } catch (err) {
        this.log('ERROR', '❌ Error in direct handler:', err.message);
      }
    });

    // Debug all received events
    this.ig.realtime.on('receive', (topic, messages) => {
      // Safely convert topic to string for checking
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message')) {
        this.log('INFO', `📥 [Realtime] Received: ${topicStr}`);
      }
    });

    // Error handling
    this.ig.realtime.on('error', (err) => {
      this.log('ERROR', '🚨 Realtime error:', err.message || err);
    });

    this.ig.realtime.on('close', () => {
      this.log('WARN', '🔌 Realtime connection closed');
    });
  }

  isNewMessage(message) {
    try {
      // Instagram timestamps are in microseconds
      const messageTime = new Date(parseInt(message.timestamp) / 1000);
      
      this.log('INFO', `⏰ Message time: ${messageTime.toISOString()}, Last check: ${this.lastMessageCheck.toISOString()}`);

      const isNew = messageTime > this.lastMessageCheck;
      
      if (isNew) {
        this.lastMessageCheck = messageTime;
        this.log('INFO', '✅ Message is new');
      } else {
        this.log('WARN', '❌ Message is old');
      }

      return isNew;
    } catch (error) {
      this.log('ERROR', '❌ Error checking message timestamp:', error.message);
      return true; // Default to processing
    }
  }

  async handleMessage(message, eventData) {
    try {
      // Try to find sender info from different possible locations
      let sender = null;
      if (eventData.thread && eventData.thread.users) {
        sender = eventData.thread.users.find(u => u.pk?.toString() === message.user_id?.toString());
      }
      
      const processedMessage = {
        id: message.item_id,
        text: message.text || '',
        sender: message.user_id,
        senderUsername: sender?.username || `user_${message.user_id}`,
        timestamp: new Date(parseInt(message.timestamp) / 1000),
        threadId: eventData.thread?.thread_id || message.thread_id || 'unknown',
        threadTitle: eventData.thread?.thread_title || 'Direct Message',
        type: message.item_type
      };

      this.log('INFO', `💬 New message from @${processedMessage.senderUsername}: ${processedMessage.text}`);

      // Execute message handlers
      for (const handler of this.messageHandlers) {
        try {
          await handler(processedMessage);
        } catch (handlerError) {
          this.log('ERROR', '❌ Message handler error:', handlerError.message);
        }
      }

    } catch (error) {
      this.log('ERROR', '❌ Error handling message:', error.message);
    }
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
    this.log('INFO', `📝 Added message handler (total: ${this.messageHandlers.length})`);
  }

  async sendMessage(threadId, text) {
    try {
      await this.ig.entity.directThread(threadId).broadcastText(text);
      this.log('INFO', `📤 Sent message to thread ${threadId}: ${text}`);
      return true;
    } catch (error) {
      this.log('ERROR', '❌ Error sending message:', error.message);
      throw error;
    }
  }

  async disconnect() {
    this.log('INFO', '🔌 Disconnecting from Instagram...');
    this.isRunning = false;
    
    try {
      if (this.ig.realtime) {
        await this.ig.realtime.disconnect();
      }
      this.log('INFO', '✅ Disconnected successfully');
    } catch (error) {
      this.log('WARN', '⚠️ Error during disconnect:', error.message);
    }
  }
}


// Main execution
async function main() {
  const bot = new InstagramBot();
  await bot.login(); // ✅ Login with cookies or credentials

  // ✅ Load all modules
  const moduleManager = new ModuleManager(bot);
  await moduleManager.loadModules();

  // ✅ Setup message handler
  const messageHandler = new MessageHandler(bot, moduleManager, null);

  // ✅ Route incoming messages to the handler
  bot.onMessage((message) => messageHandler.handleMessage(message));

  console.log('🚀 Bot is running with full module support. Type .help or use your commands.');

  // ✅ Heartbeat every 30 seconds
  setInterval(() => {
    console.log(`💓 Bot heartbeat - Running: ${bot.isRunning}, Last check: ${bot.lastMessageCheck.toISOString()}`);
  }, 300000);

  // ✅ Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    await bot.disconnect();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('❌ Bot failed to start:', error.message);
  process.exit(1);
});

// Export for external usage
export { InstagramBot };
