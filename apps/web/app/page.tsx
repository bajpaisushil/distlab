'use client';

import dynamic from 'next/dynamic';

// The lab is a client-only application: it runs the simulation in a Web
// Worker and keeps everything in the browser. Nothing is rendered on a server.
const Lab = dynamic(() => import('@/components/lab/Lab').then((m) => m.Lab), {
  ssr: false,
  loading: () => (
    <div style={{ display: 'grid', placeItems: 'center', height: '100dvh', color: 'var(--muted)' }}>Starting the lab…</div>
  ),
});

export default function Page() {
  return <Lab />;
}
