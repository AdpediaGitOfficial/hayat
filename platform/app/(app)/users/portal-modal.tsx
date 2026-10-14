'use client'
/**
 * The shared Modal, rendered into <body>. Cards use `backdrop-filter`, which makes `position: fixed` inside them
 * relative to the card, so a modal opened from a card would be clipped to it. (A fix in src/ui/Modal itself would
 * make this wrapper unnecessary.)
 */
import { useEffect, useState, type ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { Modal as UiModal } from '@/ui'

export function Modal(props: ComponentProps<typeof UiModal>) {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return ready ? createPortal(<UiModal {...props} />, document.body) : null
}
