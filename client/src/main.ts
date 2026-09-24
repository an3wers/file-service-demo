import { createApp } from 'vue'
import { createWebHistory } from 'vue-router'
import { toast } from 'vue-sonner'
import './style.css'
// vue-sonner v2 не тянет свои стили сам, а сгенерированный Sonner.vue их не импортирует.
import 'vue-sonner/style.css'
import App from './App.vue'
import { useAuth } from './composables/useAuth'
import { useFileBrowser } from './composables/useFileBrowser'
import { useUpload } from './composables/useUpload'
import { createAppRouter } from './router'

const router = createAppRouter({
  history: createWebHistory(),
  auth: useAuth(),
  upload: useUpload(),
  browser: useFileBrowser(),
  notify: (message) => toast.error(message),
})

createApp(App).use(router).mount('#app')
