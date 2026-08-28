import type { DirectoriesResponse } from "@/types/api"
import { apiRequest, buildQuery } from "./client"

export function listDirectories(
  parent: string,
  signal?: AbortSignal,
): Promise<DirectoriesResponse> {
  // `parent=""` — корень; параметр передаём всегда, пустую строку не выбрасываем.
  return apiRequest<DirectoriesResponse>(`/directories${buildQuery({ parent })}`, { signal })
}
