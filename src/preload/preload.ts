import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { OdaApi, RendererEvents } from '../shared/ipc';

const EVENTS: readonly string[] = ['client.status', 'client.event', 'app.focus'];

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api: OdaApi = {
  app: {
    info: call('app.info'),
    openLogs: call('app.openLogs'),
    openExternal: call('app.openExternal'),
    openMicPrivacy: call('app.openMicPrivacy'),
    notify: call('app.notify'),
    copyText: call('app.copyText'),
    quit: call('app.quit'),
  } as OdaApi['app'],
  settings: {
    get: call('settings.get'),
    set: call('settings.set'),
  } as OdaApi['settings'],
  client: {
    status: call('client.status'),
    savedHosts: call('client.savedHosts'),
    previewInvite: call('client.previewInvite'),
    createAccount: call('client.createAccount'),
    joinWithInvite: call('client.joinWithInvite'),
    connectSaved: call('client.connectSaved'),
    updateSavedAddress: call('client.updateSavedAddress'),
    disconnect: call('client.disconnect'),
    forget: call('client.forget'),
    request: call('client.request'),
    sfuUrl: call('client.sfuUrl'),
  } as OdaApi['client'],
  backup: {
    exportTo: call('backup.exportTo'),
    importFrom: call('backup.importFrom'),
  } as OdaApi['backup'],
  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error('unknown event');
    const listener = (_e: IpcRendererEvent, name: string, payload: unknown) => {
      if (name === event) cb(payload as RendererEvents[typeof event]);
    };
    ipcRenderer.on('oda:event', listener);
    return () => ipcRenderer.removeListener('oda:event', listener);
  },
};

contextBridge.exposeInMainWorld('oda', api);
