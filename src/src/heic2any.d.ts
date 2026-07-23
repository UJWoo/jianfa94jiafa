declare module "heic2any" {
  type Heic2AnyOptions = {
    blob: Blob;
    toType?: "image/jpeg" | "image/png" | "image/gif";
    quality?: number;
    multiple?: boolean;
  };

  export default function heic2any(
    options: Heic2AnyOptions,
  ): Promise<Blob | Blob[]>;
}
