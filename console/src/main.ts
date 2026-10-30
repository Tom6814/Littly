import { createApp } from 'vue'
// Inter Variable — the design system's fractional weights (360/450/520) only
// render correctly with the variable font.
import '@fontsource-variable/inter'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { initUi } from './stores/ui'

initUi()

createApp(App).use(router).mount('#app')
