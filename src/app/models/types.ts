export type StageStatus = 'pending' | 'running' | 'completed' | 'failed';
export type LogType = 'info' | 'success' | 'warning' | 'error';
export type FileStatus = 'pending' | 'completed' | 'failed' | 'running';

export interface Stage {
  status: StageStatus;
  startTime: string | null;
  endTime: string | null;
  message: string;
}

export interface PipelineStages {
  download:         Stage;
  classification:   Stage;
  splitAdmin:       Stage;
  afterLigatureFix: Stage;
  moveToFinal:      Stage;
  notification:     Stage;
}

export interface SessionStats {
  totalPdfs:             number;
  scannedPdfs:           number;
  regularPdfs:           number;
  corruptedPdfs:         number;
  totalPages:            number;
  adminSplitCount:       number;
  afterLigatureFixCount: number;
  finalCount:            number;
}

export interface FileRecord {
  name:                   string;
  sizeKB:                 number;
  pages:                  number;
  isScanned:              boolean;
  category:               'scanned' | 'regular' | 'unknown';
  downloadStatus:         FileStatus;
  downloadedAt:           string | null;
  adminFolder?:           string | null;
  afterLigatureFixStatus: FileStatus;
  afterLigatureFixAt?:    string | null;
  finalStatus:            FileStatus;
  movedAt?:               string | null;
  downloadError?:         string;
}

export interface Session {
  id:            string;
  date:          string;
  createdAt:     string;
  overallStatus: string;
  stages:        PipelineStages;
  stats:         SessionStats;
  files:         FileRecord[];
  reportPath:    string | null;
}

export interface ActivityLog {
  id:        string;
  timestamp: string;
  type:      LogType;
  message:   string;
  details:   Record<string, unknown>;
}

export interface DashboardData {
  today:      string;
  session:    Session;
  logs:       ActivityLog[];
  history:    Partial<Session>[];
  serverTime: string;
}

export interface FolderStatus {
  path:      string;
  exists:    boolean;
  fileCount: number;
}

export interface FolderStatuses {
  dateFolder:         FolderStatus;
  scannedPdf:         FolderStatus;
  corruptedPdf:       FolderStatus;
  outputWithDatetime: FolderStatus;
  admin1:             FolderStatus;
  admin2:             FolderStatus;
  admin3:             FolderStatus;
  afterLigatureFix:   FolderStatus;
  finalConversion:    FolderStatus;
  reports:            FolderStatus;
}
