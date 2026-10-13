import { useEffect } from 'react';
import { useAuthRouter } from './auth/useAuthRouter.js';
import { AuthGate } from './auth/AuthGate.js';
import { LegacyShell } from './legacy/LegacyShell.js';
import { toast } from './ui/toast.js';

export function App() {
    const router = useAuthRouter();

    useEffect(() => {
        if ('serviceWorker' in navigator && location.protocol === 'https:') {
            // Registered only over HTTPS: a service worker on a plain-http origin
            // is either refused or, worse, cached from an origin an attacker can
            // occupy.
            navigator.serviceWorker.register('/sw.js').catch((error) => {
                console.info('[pwa] service worker not registered', (error as Error)?.message);
            });
        }
        const onOnline = () => toast('Back online - syncing.', 'success');
        const onOffline = () => toast('Offline. You can keep reading; changes will sync when you reconnect.', 'warn', 6000);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, []);

    if (router.gate === 'app') return <LegacyShell router={router} />;
    return <AuthGate router={router} />;
}
