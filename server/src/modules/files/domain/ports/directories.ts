export interface DirectoryDto {
  name: string;
  path: string;
  fileCount: number;
}

export interface DirectoriesForUpload {
  exists(path: string): Promise<boolean>;
}

export interface DirectoriesForCatalog extends DirectoriesForUpload {
  create(parent: string, name: string): Promise<boolean>;
  listChildren(parent: string): Promise<DirectoryDto[]>;
  remove(path: string): Promise<"removed" | "missing" | "occupied">;
  move(
    path: string,
    parent: string,
    name: string,
  ): Promise<
    "moved" | "missing" | "target-missing" | "exists" | "busy" | "too-long"
  >;
}
