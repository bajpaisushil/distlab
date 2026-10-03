'use client';

import { useLab } from '@/lib/store';
import { LibraryView } from '@/components/views/LibraryView';
import { CompareView } from '@/components/views/CompareView';
import { ExperimentsView } from '@/components/views/ExperimentsView';

export function Views() {
  const view = useLab((s) => s.view);
  return (
    <div className="view">
      {view === 'library' ? <LibraryView /> : null}
      {view === 'compare' ? <CompareView /> : null}
      {view === 'experiments' ? <ExperimentsView /> : null}
    </div>
  );
}
