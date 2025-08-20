export const config = {
  instagram: {
    username: 'nickxzaaz', // Your Instagram username
    password: '12312320Pk..', // Your Instagram password
    useMongoSession: true // Set to false to use file-based sessions
  },
  messageRequests: {
    autoApprove: true, // Auto-approve all message requests if true
  },
  audioMessages: {
    simulateMobile: true, // Simulate mobile device metadata for audio messages
  },
  telegram: {
    botToken: '7580382614:AAH30PW6TFmgRzbC7HUXIHQ35GpndbJOIEI',
    chatId: '-1002287300661',
    adminUserId: '7405203657',
    enabled: true,
  },
  
  mongo: {
    uri: 'mongodb+srv://itxelijah07:ivp8FYGsbVfjQOkj@cluster0.wh25x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
    dbName: 'hyper_instza',
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }
  },
  
  modules: {

  },
  
  admin: {
    users: ['ixnickx02', 'iarshman'] // Admin usernames
  },
  
  app: {
    logLevel: 'info',
    environment: 'development'
  }
};
