import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.lanmiao.express',
  appName: '蓝喵速递',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  android: {
    backgroundColor: '#FFF0F5',
    allowMixedContent: false,
  },
}

export default config
