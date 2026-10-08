'use client';

// Mark LIV's floating overlays, mounted once by MarkHud. Which one is up comes
// from the store (`overlay`); the confirmation banner is independent of it and
// sits above everything, as Mark raised it over whatever else was open.

import './overlays.css';
import { useMarkStore } from '@/lib/mark/store';
import SetupOverlay from './SetupOverlay';
import CustomizeOverlay from './CustomizeOverlay';
import PluginManagerOverlay from './PluginManagerOverlay';
import PluginSettingsOverlay from './PluginSettingsOverlay';
import AudioDeviceOverlay from './AudioDeviceOverlay';
import MemoryOverlay from './MemoryOverlay';
import RemoteKeyOverlay from './RemoteKeyOverlay';
import ConfirmBanner from './ConfirmBanner';

export default function MarkOverlays() {
  const overlay = useMarkStore((s) => s.overlay);
  const confirm = useMarkStore((s) => s.confirm);
  const hasRemote = useMarkStore((s) => !!s.remote);

  let panel: JSX.Element | null = null;
  switch (overlay) {
    case 'setup':
      panel = <SetupOverlay />;
      break;
    case 'customize':
      panel = <CustomizeOverlay />;
      break;
    case 'plugins':
      panel = <PluginManagerOverlay />;
      break;
    case 'plugin-settings':
      panel = <PluginSettingsOverlay />;
      break;
    case 'audio':
      panel = <AudioDeviceOverlay />;
      break;
    case 'memory':
      panel = <MemoryOverlay />;
      break;
    case 'remote':
      panel = hasRemote ? <RemoteKeyOverlay /> : null;
      break;
    default:
      panel = null;
  }

  return (
    <>
      {panel && (
        // Keyed so reopening an overlay starts it fresh, like Mark building a
        // new widget each time.
        <div className="mko-layer" key={overlay ?? ''}>
          {panel}
        </div>
      )}
      {confirm && (
        <div className="mko-layer mko-confirm-layer">
          {/* Keyed on the request so a new confirmation replaces the old one. */}
          <ConfirmBanner key={`${confirm.title}\u0000${confirm.detail}`} title={confirm.title} detail={confirm.detail} />
        </div>
      )}
    </>
  );
}
