<script setup lang="ts">
import { computed } from 'vue'
import { useColorScheme } from '@/composables/useColorScheme'

import logoImage from '@/assets/relow-flow.png'

const { isDark } = useColorScheme()

const CustomLogo = computed(() => {
	const lightLogo = window.CUSTOM_LOGO_URL ?? ''
	const darkLogo = window.CUSTOM_LOGO_URL_DARK ?? ''

	if (!lightLogo && !darkLogo) return ''
	if (!darkLogo) return lightLogo
	if (!lightLogo) return darkLogo

	return isDark.value ? darkLogo : lightLogo
})

const logo = computed(() => CustomLogo.value || logoImage)
</script>

<template>
	<img
		:src="logo"
		alt="Flow"
		class="logo"
	>
</template>

<style lang="scss" scoped>
.logo {
	max-inline-size: 168px;
	max-block-size: 48px;
	object-fit: contain;
}
</style>
