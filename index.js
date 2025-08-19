import { InstagramBot } from './core/bot.js';
import { TelegramBridge } from './telegram/bridge.js';
import { ModuleManager } from './core/module-manager.js';
import { MessageHandler } from './core/message-handler.js';
import { logger } from './utils/utils.js'; 
import { config } from './config.js';
import { connectDb } from './utils/db.js';

class HyperInsta {
  constructor() {
    this.startTime = new Date();
    this.instagramBot = new InstagramBot();
    this.telegramBridge = config.telegram?.enabled ? new TelegramBridge() : null;
  }

 async initialize() {
  try {
    this.showStartupBanner();

    console.log('🗄️ Connecting to MongoDB...');
    await connectDb();
    console.log('✅ MongoDB connected');

    console.log('📱 Connecting to Instagram...');
    await this.instagramBot.login();
    console.log('✅ Instagram connected');
    console.log('DEBUG: InstagramBot ig property exists:', !!this.instagramBot.ig); // Debug log

    if (this.telegramBridge) {
      console.log('📨 Initializing Telegram...');
      console.log('DEBUG: Passing instagramBot to TelegramBridge:', !!this.instagramBot, !!this.instagramBot.ig);
      await this.telegramBridge.initialize(this.instagramBot);
      console.log('✅ Telegram connected');
    }

    console.log('🔌 Loading modules...');
    const moduleManager = new ModuleManager(this.instagramBot);
    await moduleManager.loadModules();
    console.log('✅ Modules loaded');

    console.log('📨 Initializing message handler...');
    const messageHandler = new MessageHandler(this.instagramBot, moduleManager, this.telegramBridge);
    this.instagramBot.onMessage((message) => messageHandler.handleMessage(message));
    console.log('✅ Message handler connected');

    console.log(`🔔 Message request auto-approval: ${config.messageRequests?.autoApprove ? 'Enabled' : 'Disabled'}`);
    console.log('✅ Bot is now LIVE and ready!');
    this.showLiveStatus();

  } catch (error) {
    console.error(`❌ Startup failed: ${error.message}`);
    console.debug(error.stack);
    if (this.instagramBot) {
      try {
        await this.instagramBot.disconnect();
      } catch (disconnectError) {
        console.error('❌ Error during cleanup disconnect:', disconnectError.message);
      }
    }
    process.exit(1);
  }
}

  showStartupBanner() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - INITIALIZING                           ║
║                                                              ║
║    ⚡ Ultra Fast • 🔌 Modular • 🛡️ Robust                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
  }

  showLiveStatus() {
    const uptime = Date.now() - this.startTime;
    console.clear();
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - LIVE & OPERATIONAL                     ║
║                                                              ║
║    ✅ Instagram: Connected & Active                         ║
║    ${this.telegramBridge ? '✅' : '❌'} Telegram: ${this.telegramBridge ? 'Connected & Bridged' : 'Disabled'}                        ║
║    ⚡ Startup Time: ${Math.round(uptime)}ms                                  ║
║    🕒 Started: ${this.startTime.toLocaleTimeString()}                                ║
║                                                              ║
║    🎯 Ready for INSTANT commands...                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🔥 Bot is running at MAXIMUM PERFORMANCE!
💡 Type .help in Instagram to see all commands
    `);
  }

  async start() {
    await this.initialize();

    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down gracefully...');
      await this.instagramBot.disconnect();
      console.log('✅ Hyper Insta stopped');
      process.exit(0);
    });
  }
}

const bot = new HyperInsta();
bot.start().catch(console.error);
