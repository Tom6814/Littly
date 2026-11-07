<script setup lang="ts">
// CodePanel — a read-only block of code with its copy button: the chat code
// fence, a command the user must paste into a terminal, a config snippet.
// Lifted from the host's chat code block (apps/web/src/pages/home/components/
// chat-code-block.vue, now a caller of this) so every code surface shares one
// frame. It owns ONLY the frame — the menu-shell radius (same rung as
// SettingsSection / SurfaceCard, so a code block next to a settings card lines
// up), fill, the shared card edge rule (surfaceEdgeClass: no edge in dark
// mode unless `bordered`), inset, mono type and the copy button. Highlighting is the
// caller's: pass rendered markup through the default slot; without one the
// `code` text is shown as-is.
//
// Layout is a flex row — the code sits in its own column and the copy button
// is a stable trailing sibling (top-aligned), so the block stays
// fit-to-content without a reserved gap and the button does not jitter while
// streaming content grows the width.
import { surfaceEdgeClass } from '#/lib/surface'
import { CopyButton } from '../copy-button'

withDefaults(defineProps<{
  /** The exact text the copy button writes to the clipboard. */
  code: string
  /** Copy button accessible name at rest (caller i18n). */
  copyLabel: string
  /** Copy button accessible name while the check is shown (caller i18n). */
  copiedLabel: string
  /** Toast shown when the clipboard write fails (caller i18n). */
  copyFailedMessage: string
  /**
   * `fit` hugs the code (chat fences, capped at the container width);
   * `full` fills the row (a command in a dialog).
   */
  width?: 'fit' | 'full'
  /**
   * Wrap long lines instead of scrolling them. Use it for a one-line shell
   * command that must be read in full: `wrap-anywhere` lets an unbroken
   * token (a key, a URL) break so it never widens the host. Wrapped rows are
   * one logical line, so they take relaxed leading instead of the 1.8 used
   * to separate real code lines.
   */
  wrap?: boolean
  /** Keep the edge in dark mode when nested inside another card-colored surface (a dialog body). */
  bordered?: boolean
}>(), {
  width: 'full',
  wrap: false,
  bordered: false,
})
</script>

<template>
  <div
    data-slot="code-panel"
    class="flex max-w-full items-start gap-1.5 overflow-hidden rounded-menu-shell bg-card py-1 pl-3.5 pr-1.5"
    :class="[surfaceEdgeClass(bordered), width === 'fit' ? 'w-fit' : 'w-full']"
  >
    <div
      class="min-w-0 py-1.5 font-mono text-label text-foreground"
      :class="[width === 'full' && 'flex-1', wrap ? 'whitespace-pre-wrap wrap-anywhere leading-relaxed' : 'overflow-x-auto leading-[1.8]']"
    >
      <slot>
        <pre
          class="m-0 font-mono"
          :class="wrap ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre'"
        ><code>{{ code }}</code></pre>
      </slot>
    </div>
    <CopyButton
      :text="code"
      :label="copyLabel"
      :copied-label="copiedLabel"
      :failed-message="copyFailedMessage"
      icon-class="size-3.5"
      class="shrink-0 text-muted-foreground hover:text-foreground"
    />
  </div>
</template>
