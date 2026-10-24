import type { DirectoryDto, DirectoriesResponse } from "@/types/api";
import { apiRequest, buildQuery } from "./client";

export function listDirectories(
  parent: string,
  signal?: AbortSignal,
): Promise<DirectoriesResponse> {
  // `parent=""` — корень; параметр передаём всегда, пустую строку не выбрасываем.
  return apiRequest<DirectoriesResponse>(
    `/directories${buildQuery({ parent })}`,
    { signal },
  );
}

export function createDirectory(
  parent: string,
  name: string,
): Promise<DirectoryDto> {
  return apiRequest<DirectoryDto>("/directories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent, name }),
  });
}

export function updateDirectory(
  path: string,
  change: { name?: string; parent?: string },
): Promise<DirectoryDto> {
  return apiRequest<DirectoryDto>(`/directories${buildQuery({ path })}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
}

export function deleteDirectory(path: string): Promise<void> {
  return apiRequest<void>(`/directories${buildQuery({ path })}`, {
    method: "DELETE",
  });
}
