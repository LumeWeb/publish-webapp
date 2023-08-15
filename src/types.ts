export interface WebAppMetadata {
  type: "web_app";
  name?: string;
  tryFiles?: string[];
  errorPages?: {
    [key: string]: string; // key should match the pattern ^\d{3}$
  };
  paths: {
    [path: string]: PathContent; // path has maxLength 255
  };
  extraMetadata?: ExtraMetadata; // I'm assuming this as any since the actual structure isn't provided
}

export interface PathContent {
  cid: CID; // Assuming CID is another interface or type
  contentType?: string; // Should match the provided pattern
  size: number;
}

// Placeholder definitions based on the $ref in the schema.
// You should replace these with the actual structures if you have them.
export type CID = any;
export type ExtraMetadata = any;
