import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DashboardService } from '../../services/dashboard.service';
import type { StageStatus } from '../../models/types';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent {
  ds = inject(DashboardService);

  // ── Sidebar ──────────────────────────────────────────────────────────────
  sidebarOpen = signal(false);
  toggleSidebar() { this.sidebarOpen.update(v => !v); }
  closeSidebar()  { this.sidebarOpen.set(false); }

  // ── Filter / search ──────────────────────────────────────────────────────
  fileFilter      = signal('');
  filterCategory  = signal<'all' | 'scanned' | 'regular'>('all');

  filteredFiles = computed(() => {
    const q   = this.fileFilter().toLowerCase();
    const cat = this.filterCategory();
    return this.ds.files().filter((f) => {
      const matchName = !q || f.name.toLowerCase().includes(q);
      const matchCat  = cat === 'all' || f.category === cat;
      return matchName && matchCat;
    });
  });

  // ── Confirmation modal ───────────────────────────────────────────────────
  pendingAction = signal<null | { label: string; detail?: string; fn: () => void; danger?: boolean }>(null);

  confirm(label: string, fn: () => void, detail?: string, danger = false) {
    this.pendingAction.set({ label, fn, detail, danger });
  }

  executeAction() {
    this.pendingAction()?.fn();
    this.pendingAction.set(null);
  }

  cancelAction() {
    this.pendingAction.set(null);
  }

  // ── Pipeline stage definitions ───────────────────────────────────────────
  readonly pipelineSteps = [
    {
      key: 'download',
      label: 'SFTP Download',
      icon: 'fa-cloud-arrow-down',
      description: 'Downloads PDFs from SFTP daily folder',
      isManual: false,
      color: 'text-primary',
    },
    {
      key: 'classification',
      label: 'PDF Classification',
      icon: 'fa-folder-open',
      description: 'Sorts scanned vs. digital PDFs',
      isManual: false,
      color: 'text-info',
    },
    {
      key: 'splitAdmin',
      label: 'Split Admin Folders',
      icon: 'fa-code-branch',
      description: 'Distributes PDFs equally across admin_1, admin_2, admin_3 by page count',
      isManual: false,
      color: 'text-purple',
    },
    {
      key: 'afterLigatureFix',
      label: 'PDF → DOC Conversion + Ligature Fix',
      icon: 'fa-gears',
      description: 'Manual: Adobe conversion + ligature fix → place files in afterLigatureFix/',
      isManual: true,
      color: 'text-warning',
    },
    {
      key: 'moveToFinal',
      label: 'Move to Final',
      icon: 'fa-check-circle',
      description: 'Moves fixed DOC files to final_conversion',
      isManual: false,
      color: 'text-success',
    },
    {
      key: 'notification',
      label: 'Email Notify',
      icon: 'fa-envelope',
      description: 'Sends stakeholder summary email',
      isManual: false,
      color: 'text-secondary',
    },
  ];

  getStage(key: string) {
    const s = this.ds.stages() as Record<string, { status: StageStatus; message: string; startTime: string | null; endTime: string | null }> | null;
    return s?.[key] ?? null;
  }

  stageClass(status: StageStatus | undefined) {
    switch (status) {
      case 'completed': return 'stage-completed';
      case 'running':   return 'stage-running';
      case 'failed':    return 'stage-failed';
      default:          return 'stage-pending';
    }
  }

  logClass(type: string) {
    switch (type) {
      case 'success': return 'log-success';
      case 'warning': return 'log-warning';
      case 'error':   return 'log-error';
      default:        return 'log-info';
    }
  }

  formatTime(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  formatDate(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  formatSize(kb: number) {
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
  }

  overallProgress() {
    const stages = this.ds.stages();
    if (!stages) return 0;
    const keys = ['download', 'classification', 'splitAdmin', 'afterLigatureFix', 'moveToFinal', 'notification'] as const;
    const completed = keys.filter((k) => stages[k]?.status === 'completed').length;
    return Math.round((completed / keys.length) * 100);
  }
}
