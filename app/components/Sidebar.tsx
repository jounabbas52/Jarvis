'use client';

import {
  HomeIcon,
  ChatIcon,
  CommandIcon,
  SystemIcon,
  FolderIcon,
  AppsIcon,
  SettingsIcon,
  MemoryIcon,
  LogsIcon,
  InfoIcon,
  PilotIcon,
  BotIcon,
} from './Icons';
import { useJarvisStore } from '@/lib/store';

export type View = 'hud' | 'dashboard' | 'chat' | 'pilot' | 'commands' | 'system' | 'files' | 'apps' | 'settings' | 'memory' | 'logs' | 'about';

const NAV: { id: View; label: string; icon: typeof HomeIcon }[] = [
  { id: 'hud', label: 'Mark HUD', icon: BotIcon },
  { id: 'dashboard', label: 'Dashboard', icon: HomeIcon },
  { id: 'chat', label: 'Chat', icon: ChatIcon },
  { id: 'pilot', label: 'Pilot', icon: PilotIcon },
  { id: 'commands', label: 'Commands', icon: CommandIcon },
  { id: 'system', label: 'System Control', icon: SystemIcon },
  { id: 'files', label: 'Files & Folders', icon: FolderIcon },
  { id: 'apps', label: 'Apps', icon: AppsIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'memory', label: 'Memory', icon: MemoryIcon },
  { id: 'logs', label: 'Logs', icon: LogsIcon },
  { id: 'about', label: 'About', icon: InfoIcon },
];

export default function Sidebar({ active, onSelect }: { active: View; onSelect: (v: View) => void }) {
  const isListening = useJarvisStore((s) => s.isListening);

  return (
    <aside className="w-[224px] shrink-0 h-full flex flex-col glass-panel border-r px-3 py-4">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-1.5 mb-4">
        <div className="relative w-9 h-9 shrink-0 flex items-center justify-center rounded-full border-2 border-jarvis-accent2/60" style={{ borderColor: 'var(--jarvis-accent-2)' }}>
          <div className="absolute inset-0 rounded-full animate-pulseRing" style={{ border: '2px solid var(--jarvis-accent-2)' }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: 'var(--jarvis-accent-2)' }} />
        </div>
        <div className="leading-tight">
          <p className="text-[15px] font-bold tracking-wide">
            JARVIS <span style={{ color: 'var(--jarvis-accent)' }}>LITE</span>
          </p>
          <p className="text-[11px] tracking-[0.2em] text-jarvis-subtext" style={{ color: 'var(--jarvis-subtext)' }}>
            AI ASSISTANT
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 flex flex-col gap-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const isActive = active === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium active:scale-[0.98] ${
                isActive ? 'text-white' : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
              style={{
                backgroundColor: isActive ? 'var(--jarvis-accent)' : 'transparent',
                color: isActive ? '#fff' : 'var(--jarvis-text)',
              }}
            >
              <Icon className="opacity-90" width={16} height={16} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Listening indicator */}
      <div className="mt-3 rounded-xl glass-panel py-4 flex flex-col items-center gap-2">
        <p className="text-sm text-jarvis-subtext" style={{ color: 'var(--jarvis-subtext)' }}>
          {isListening ? 'Listening...' : 'Idle'}
        </p>
        <div className="relative w-14 h-14 rounded-full flex items-center justify-center border" style={{ borderColor: 'var(--jarvis-accent)' }}>
          {isListening && <div className="absolute inset-0 rounded-full animate-pulseRing" style={{ border: '2px solid var(--jarvis-accent)' }} />}
          <div className="flex items-end gap-[2px] h-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={`w-[2px] rounded-full ${isListening ? 'animate-wave' : ''}`}
                style={{
                  height: isListening ? '100%' : '35%',
                  backgroundColor: 'var(--jarvis-accent)',
                  animationDelay: `${i * 0.12}s`,
                }}
              />
            ))}
          </div>
        </div>
        <p className="text-xs text-jarvis-subtext" style={{ color: 'var(--jarvis-subtext)' }}>
          {isListening ? 'Tap to stop' : 'Tap mic to speak'}
        </p>
      </div>
    </aside>
  );
}
