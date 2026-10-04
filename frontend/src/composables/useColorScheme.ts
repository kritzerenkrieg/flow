import {computed, watch, readonly} from 'vue'
import {createSharedComposable, tryOnMounted} from '@vueuse/core'
import {useAuthStore} from '@/stores/auth'

const CLASS_DARK = 'dark'
const CLASS_LIGHT = 'light'

// White-label: the UI is always bright.
// Dark mode and the system color scheme preference are disabled — the stored
// color_schema setting and prefers-color-scheme are intentionally ignored.
export const useColorScheme = createSharedComposable(() => {
	const authStore = useAuthStore()
	const store = computed(() => authStore.settings.frontend_settings.color_schema)

	const isDark = computed<boolean>(() => false)

	function onChanged(v: boolean) {
		const el = window?.document.querySelector('html')
		el?.classList.toggle(CLASS_DARK, v)
		el?.classList.toggle(CLASS_LIGHT, !v)
	}

	watch(isDark, onChanged, { flush: 'post' })

	tryOnMounted(() => onChanged(isDark.value))

	return {
		store,
		isDark: readonly(isDark),
	}
})
