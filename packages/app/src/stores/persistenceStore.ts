// Persistence utilities for saving/restoring UI state per folder

const STORAGE_KEY_PREFIX = "codecartographer_";
const LAST_FOLDER_KEY = `${STORAGE_KEY_PREFIX}lastFolder`;
const FOLDER_STATE_PREFIX = `${STORAGE_KEY_PREFIX}folder_`;

interface FolderState {
  expandedNodes: string[];
  visibleNodes: string[];
}

function hashPath(path: string): string {
  // Simple hash for folder path to use as storage key
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export function saveLastFolder(path: string): void {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch (e) {
    console.warn("Failed to save last folder:", e);
  }
}

export function getLastFolder(): string | null {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY);
  } catch (e) {
    console.warn("Failed to get last folder:", e);
    return null;
  }
}

export function saveFolderState(
  folderPath: string,
  expandedNodes: Set<string>,
  visibleNodes: Set<string>
): void {
  try {
    const key = FOLDER_STATE_PREFIX + hashPath(folderPath);
    const state: FolderState = {
      expandedNodes: Array.from(expandedNodes),
      visibleNodes: Array.from(visibleNodes),
    };
    localStorage.setItem(key, JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save folder state:", e);
  }
}

export function loadFolderState(folderPath: string): FolderState | null {
  try {
    const key = FOLDER_STATE_PREFIX + hashPath(folderPath);
    const data = localStorage.getItem(key);
    if (!data) return null;
    return JSON.parse(data) as FolderState;
  } catch (e) {
    console.warn("Failed to load folder state:", e);
    return null;
  }
}
