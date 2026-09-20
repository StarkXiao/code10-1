import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { VueQueryPlugin } from '@tanstack/vue-query';
import 'element-plus/dist/index.css';
import './styles/main.css';
import App from './App.vue';
import { router } from './router';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.use(VueQueryPlugin, {
  queryClientConfig: {
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // 这是一个"边记边看"的档案类应用：重新进入页面时应该拿到服务端最新状态，
        // 否则刚提交的修补/复检会跟档案页显示的旧数据打架。
        refetchOnMount: 'always',
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  },
});
app.mount('#app');
