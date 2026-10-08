'use client';

import { useEffect, useState } from 'react';
import Sidebar, { View } from './components/Sidebar';
import TopBar from './components/TopBar';
import Chat from './components/Chat';
import InputBar from './components/InputBar';
import StatusPanel from './components/StatusPanel';
import CommandsView from './components/CommandsView';
import LogsView from './components/LogsView';
import SettingsView from './components/SettingsView';
import AboutView from './components/AboutView';
import FilesView from './components/FilesView';
import AppsView from './components/AppsView';
import SystemView from './components/SystemView';
import MemoryView from './components/MemoryView';
import PilotView from './components/PilotView';
import StatusBar from './components/StatusBar';
import MarkHud from './components/mark/MarkHud';
import { useJarvisStore } from '@/lib/store';
import { useMarkStore } from '@/lib/mark/store';
import { startMarkLive } from '@/lib/mark/live';
// Registers the local "Hey Jarvis" detector with the Live controller.
import '@/lib/mark/wake';

export default function Home() {
  const [view, setView] = useState<View>('hud');
  const hydrate = useJarvisStore((s) => s.hydrate);
  const hydrated = useJarvisStore((s) => s.hydrated);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Mark LIV runs for the life of the window, whichever view is showing: it is
  // a voice assistant, and switching to the old panels must not hang it up.
  useEffect(() => {
    useMarkStore
      .getState()
      .init()
      .catch((e) => console.error('[Mark] init failed', e))
      .finally(() => startMarkLive());
  }, []);

  if (!hydrated) {
    return (
      <div className="h-screen w-screen flex items-center justify-center" style={{ backgroundColor: 'var(--jarvis-bg)', color: 'var(--jarvis-text)' }}>
        <p className="text-sm" style={{ color: 'var(--jarvis-subtext)' }}>
          Waking up Jarvis...
        </p>
      </div>
    );
  }

  const showFullDashboard = view === 'dashboard' || view === 'chat';

  return (
    <div className="h-screen w-screen flex flex-col" style={{ backgroundColor: 'var(--jarvis-bg)', color: 'var(--jarvis-text)' }}>
      <div className="flex-1 flex min-h-0">
        <Sidebar active={view} onSelect={setView} />

        {/* Mark's window is full-bleed: no TopBar / StatusBar chrome around it. */}
        {view === 'hud' && (
          <main className="flex-1 flex min-w-0 min-h-0">
            <MarkHud />
          </main>
        )}

        {view !== 'hud' && (
        <main className="flex-1 flex flex-col min-w-0">
          <TopBar />

          <div className="flex-1 flex min-h-0">
            {view === 'dashboard' && (
              <>
                <section className="flex-1 flex flex-col min-w-0">
                  <Chat />
                  <InputBar />
                </section>
                <StatusPanel onSelect={setView} />
              </>
            )}

            {view === 'chat' && (
              <section className="flex-1 flex flex-col min-w-0">
                <Chat />
                <InputBar />
              </section>
            )}

            {view === 'pilot' && <PilotView />}
            {view === 'commands' && <CommandsView />}
            {view === 'system' && <SystemView />}
            {view === 'files' && <FilesView />}
            {view === 'apps' && <AppsView />}
            {view === 'settings' && <SettingsView />}
            {view === 'memory' && <MemoryView />}
            {view === 'logs' && <LogsView />}
            {view === 'about' && <AboutView />}
          </div>
        </main>
        )}
      </div>
      {view !== 'hud' && <StatusBar onSelect={setView} />}
    </div>
  );
}
