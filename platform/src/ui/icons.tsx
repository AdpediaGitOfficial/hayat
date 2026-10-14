'use client'

import {
  LayoutDashboard, Users, LogOut, ClipboardCheck, Building2, BedDouble, ArrowLeftRight, CheckCircle2, Hourglass,
  KeyRound, Box, CalendarDays, ShieldCheck, BarChart3, FileText, Wrench, Siren, Clock, UserCog, LogIn, Search, Bell,
  HelpCircle, MapPin, ChevronRight, ChevronDown, ChevronsUpDown, Plus, Download, Filter, MoreHorizontal, X, AlertTriangle,
  Info, Check, Sun, Moon, Upload, Sparkles, Home, Brush, Eye, Lock, Phone, ArrowRight, RotateCcw, Play, FastForward,
  UserPlus, ListChecks, Shuffle, Layers, Ban, Send, BadgeCheck, Settings, ScrollText, User, Briefcase, Truck, Radio,
} from 'lucide-react'

export const ICONS = {
  dashboard: LayoutDashboard, users: Users, exit: LogOut, clipboard: ClipboardCheck, building: Building2, bed: BedDouble,
  swap: ArrowLeftRight, check: Check, checkCircle: CheckCircle2, hourglass: Hourglass, key: KeyRound, box: Box,
  calendar: CalendarDays, shield: ShieldCheck, chart: BarChart3, file: FileText, wrench: Wrench, siren: Siren, clock: Clock,
  userCog: UserCog, login: LogIn, search: Search, bell: Bell, help: HelpCircle, pin: MapPin, chevronRight: ChevronRight,
  chevronDown: ChevronDown, updown: ChevronsUpDown, plus: Plus, download: Download, filter: Filter, more: MoreHorizontal,
  x: X, alert: AlertTriangle, info: Info, sun: Sun, moon: Moon, upload: Upload, sparkles: Sparkles, home: Home, brush: Brush,
  eye: Eye, lock: Lock, phone: Phone, arrowRight: ArrowRight, undo: RotateCcw, play: Play, fast: FastForward,
  userPlus: UserPlus, list: ListChecks, shuffle: Shuffle, layers: Layers, ban: Ban, send: Send, badge: BadgeCheck,
  settings: Settings, scroll: ScrollText, user: User, briefcase: Briefcase, truck: Truck, radio: Radio,
} as const
export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  const C = ICONS[name]
  return <C size={size} strokeWidth={1.75} aria-hidden={label ? undefined : true} aria-label={label} className={className} />
}
