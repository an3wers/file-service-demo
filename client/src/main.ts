import { createApp } from 'vue'
import './style.css'
// vue-sonner v2 не тянет свои стили сам, а сгенерированный Sonner.vue их не импортирует.
import 'vue-sonner/style.css'
import App from './App.vue'

createApp(App).mount('#app')
