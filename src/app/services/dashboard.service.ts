import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { interval, switchMap, startWith, catchError, of } from 'rxjs';
import type { DashboardData, FolderStatuses, Session, FileRecord, ActivityLog } from '../models/types';

const POLL_INTERVAL_MS = 15_000;

const defaultStats = {
  totalPdfs: 0, scannedPdfs: 0, regularPdfs: 0, corruptedPdfs: 0, totalPages: 0,
  adminSplitCount: 0, afterLigatureFixCount: 0, finalCount: 0,
};

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private http = inject(HttpClient);

  // ── State signals ────────────────────────────────────────────────────────
  readonly session      = signal<Session | null>(null);
  readonly logs         = signal<ActivityLog[]>([]);
  readonly history      = signal<Partial<Session>[]>([]);
  readonly lastUpdated  = signal<Date | null>(null);
  readonly isConnected  = signal(false);
  readonly isLoading    = signal(true);
  readonly triggerMessage = signal<{ type: 'success' | 'error'; text: string } | null>(null);
  readonly folderStatus = signal<FolderStatuses | null>(null);

  // ── Computed ─────────────────────────────────────────────────────────────
  readonly stats  = computed(() => this.session()?.stats ?? defaultStats);
  readonly files  = computed<FileRecord[]>(() => this.session()?.files ?? []);
  readonly stages = computed(() => this.session()?.stages ?? null);
  readonly today  = computed(() => this.session()?.date ?? new Date().toISOString().split('T')[0]);

  constructor() {
    this.startPolling();
    this.loadFolderStatus();
  }

  // ── Polling ──────────────────────────────────────────────────────────────
  private startPolling(): void {
    interval(POLL_INTERVAL_MS)
      .pipe(
        startWith(0),
        switchMap(() =>
          this.http.get<DashboardData>('/api/dashboard').pipe(catchError(() => of(null)))
        )
      )
      .subscribe((data) => {
        this.isLoading.set(false);
        if (data) {
          this.session.set(data.session);
          this.logs.set(data.logs);
          this.history.set(data.history);
          this.lastUpdated.set(new Date());
          this.isConnected.set(true);
        } else {
          this.isConnected.set(false);
        }
      });
  }

  loadFolderStatus(): void {
    this.http.get<FolderStatuses>('/api/folder-status').pipe(
      catchError(() => of(null))
    ).subscribe((data) => this.folderStatus.set(data));
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  triggerDownload(): void {
    this.postTrigger('/api/trigger/download', 'SFTP download triggered');
  }

  triggerSplitAdmin(): void {
    this.postTrigger('/api/trigger/split-admin', 'Admin folder split triggered');
  }

  triggerWatchAfterLigature(): void {
    this.postTrigger('/api/trigger/watch-after-ligature', 'After-Ligature-Fix watcher started');
  }

  triggerMoveToFinal(): void {
    this.postTrigger('/api/trigger/move-final', 'Move to final triggered');
  }

  triggerNotification(): void {
    this.postTrigger('/api/trigger/notify', 'Email notification triggered');
  }

  triggerRerun(): void {
    // Clear stale display immediately — before the HTTP response arrives
    this.folderStatus.set(null);
    this.session.set(null);

    this.http.post<{ ok: boolean; message: string }>('/api/trigger/rerun', {}).pipe(
      catchError((err) => of({ ok: false, message: err.message ?? 'Reset failed' }))
    ).subscribe((res) => {
      this.triggerMessage.set({ type: res.ok ? 'success' : 'error', text: res.message ?? '' });
      setTimeout(() => this.triggerMessage.set(null), 4000);
      // Reload session + folder status from the freshly reset state
      setTimeout(() => this.refreshNow(), 800);
    });
  }

  downloadReport(): void {
    window.open('/api/report/download', '_blank');
  }

  private postTrigger(url: string, successMsg: string): void {
    this.http.post<{ ok: boolean; message: string }>(url, {}).pipe(
      catchError((err) => of({ ok: false, message: err.message ?? 'Request failed' }))
    ).subscribe((res) => {
      this.triggerMessage.set({ type: res.ok ? 'success' : 'error', text: res.message ?? successMsg });
      setTimeout(() => this.triggerMessage.set(null), 4000);
      setTimeout(() => this.refreshNow(), 2000);
    });
  }

  private refreshNow(): void {
    this.http.get<DashboardData>('/api/dashboard').pipe(catchError(() => of(null))).subscribe((data) => {
      if (data) {
        this.session.set(data.session);
        this.logs.set(data.logs);
        this.lastUpdated.set(new Date());
        this.isConnected.set(true);
        this.loadFolderStatus();
      }
    });
  }
}
