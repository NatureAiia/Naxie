// Studio generative-media model catalog.
//
// Curated from the Open-Generative-AI project's model registry
// (github.com/Anil-matcha/Open-Generative-AI, models_dump.json) - the set of
// text-to-image models reachable through the Muapi unified gateway
// (api.muapi.ai/api/v1/<endpoint>). Agents call media.studio_models to discover
// what's available, then media.image with a chosen model id. Ideogram is also
// reachable via its own hosted API (see lib/studio-image.ts); it's in this list
// too so one picker covers every provider.

export type StudioModel = {
  id: string;
  name: string;
  endpoint: string;   // Muapi /api/v1/<endpoint> slug
  provider: string;
  kind: "text-to-image" | "text-to-video" | "image-to-image" | "image-to-video";
  aspectRatios?: string[];
  via?: "muapi" | "ideogram";
};

export const STUDIO_MODELS: StudioModel[] = [
  {
    "id": "nano-banana",
    "name": "Nano Banana",
    "endpoint": "nano-banana",
    "provider": "Google",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "3:4",
      "4:3",
      "9:16",
      "16:9",
      "3:2",
      "2:3",
      "5:4",
      "4:5",
      "21:9"
    ]
  },
  {
    "id": "flux-dev",
    "name": "Flux Dev",
    "endpoint": "flux-dev",
    "provider": "Black Forest Labs",
    "kind": "text-to-image"
  },
  {
    "id": "flux-dev-lora",
    "name": "Flux Dev Lora",
    "endpoint": "flux-dev-lora",
    "provider": "Black Forest Labs",
    "kind": "text-to-image"
  },
  {
    "id": "flux-kontext-dev-t2i",
    "name": "Flux Kontext Dev T2I",
    "endpoint": "flux-kontext-dev-t2i",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "21:9",
      "9:21"
    ]
  },
  {
    "id": "hidream-i1-fast",
    "name": "Hidream I1 Fast",
    "endpoint": "hidream-i1-fast",
    "provider": "Runware",
    "kind": "text-to-image"
  },
  {
    "id": "hidream-i1-dev",
    "name": "Hidream I1 Dev",
    "endpoint": "hidream-i1-dev",
    "provider": "Runware",
    "kind": "text-to-image"
  },
  {
    "id": "hidream-i1-full",
    "name": "Hidream I1 Full",
    "endpoint": "hidream-i1-full",
    "provider": "Runware",
    "kind": "text-to-image"
  },
  {
    "id": "ai-anime-generator",
    "name": "Ai Anime Generator",
    "endpoint": "ai-anime-generator",
    "provider": "Wavespeed",
    "kind": "text-to-image"
  },
  {
    "id": "wan2.1-text-to-image",
    "name": "Wan2.1 Text To Image",
    "endpoint": "wan2.1-text-to-image",
    "provider": "Alibaba",
    "kind": "text-to-image"
  },
  {
    "id": "flux-kontext-pro-t2i",
    "name": "Flux Kontext Pro T2I",
    "endpoint": "flux-kontext-pro-t2i",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9",
      "16:21"
    ]
  },
  {
    "id": "flux-kontext-max-t2i",
    "name": "Flux Kontext Max T2I",
    "endpoint": "flux-kontext-max-t2i",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9",
      "16:21"
    ]
  },
  {
    "id": "gpt4o-text-to-image",
    "name": "Gpt4o Text To Image",
    "endpoint": "gpt4o-text-to-image",
    "provider": "OpenAI",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "2:3",
      "3:2"
    ]
  },
  {
    "id": "midjourney-v7-text-to-image",
    "name": "Midjourney v7 Text To Image",
    "endpoint": "midjourney-v7-text-to-image",
    "provider": "Midjourney",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "16:9",
      "9:16",
      "3:4",
      "4:3",
      "1:2",
      "2:1",
      "2:3",
      "3:2",
      "5:6",
      "6:5"
    ]
  },
  {
    "id": "flux-schnell",
    "name": "Flux Schnell",
    "endpoint": "flux-schnell",
    "provider": "Black Forest Labs",
    "kind": "text-to-image"
  },
  {
    "id": "bytedance-seedream-v3",
    "name": "Bytedance Seedream v3",
    "endpoint": "bytedance-seedream-v3",
    "provider": "ByteDance",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "16:9",
      "9:16",
      "3:4",
      "4:3"
    ]
  },
  {
    "id": "qwen-image",
    "name": "Qwen Image",
    "endpoint": "qwen-image",
    "provider": "Alibaba",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "21:9",
      "9:21",
      "3:2",
      "2:3"
    ]
  },
  {
    "id": "flux-pulid",
    "name": "Flux Pulid",
    "endpoint": "flux-pulid",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4"
    ]
  },
  {
    "id": "ideogram-v3-t2i",
    "name": "Ideogram v3 T2I",
    "endpoint": "ideogram-v3-t2i",
    "provider": "Ideogram",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "3:4",
      "4:3",
      "9:16",
      "16:9"
    ]
  },
  {
    "id": "google-imagen4",
    "name": "Google Imagen4",
    "endpoint": "google-imagen4",
    "provider": "Google",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4"
    ]
  },
  {
    "id": "google-imagen4-fast",
    "name": "Google Imagen4 Fast",
    "endpoint": "google-imagen4-fast",
    "provider": "Google",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4"
    ]
  },
  {
    "id": "google-imagen4-ultra",
    "name": "Google Imagen4 Ultra",
    "endpoint": "google-imagen4-ultra",
    "provider": "Google",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4"
    ]
  },
  {
    "id": "sdxl-image",
    "name": "Sdxl Image",
    "endpoint": "sdxl-image",
    "provider": "Stability AI",
    "kind": "text-to-image"
  },
  {
    "id": "bytedance-seedream-v4",
    "name": "Bytedance Seedream v4",
    "endpoint": "bytedance-seedream-v4",
    "provider": "ByteDance",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "16:9",
      "9:16",
      "3:4",
      "4:3",
      "2:3",
      "3:2",
      "21:9"
    ]
  },
  {
    "id": "hunyuan-image-2.1",
    "name": "Hunyuan Image 2.1",
    "endpoint": "hunyuan-image-2.1",
    "provider": "Hunyuan",
    "kind": "text-to-image"
  },
  {
    "id": "chroma-image",
    "name": "Chroma Image",
    "endpoint": "chroma-image",
    "provider": "Stability AI",
    "kind": "text-to-image"
  },
  {
    "id": "flux-redux",
    "name": "Flux Redux",
    "endpoint": "flux-redux",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "21:9",
      "9:21"
    ]
  },
  {
    "id": "flux-krea-dev",
    "name": "Flux Krea Dev",
    "endpoint": "flux-krea-dev",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "3:2",
      "2:3",
      "21:9",
      "9:21"
    ]
  },
  {
    "id": "perfect-pony-xl",
    "name": "Perfect Pony Xl",
    "endpoint": "perfect-pony-xl",
    "provider": "Stability AI",
    "kind": "text-to-image"
  },
  {
    "id": "neta-lumina",
    "name": "Neta Lumina",
    "endpoint": "neta-lumina",
    "provider": "Stability AI",
    "kind": "text-to-image"
  },
  {
    "id": "wan2.5-text-to-image",
    "name": "Wan2.5 Text To Image",
    "endpoint": "wan2.5-text-to-image",
    "provider": "Alibaba",
    "kind": "text-to-image"
  },
  {
    "id": "hunyuan-image-3.0",
    "name": "Hunyuan Image 3.0",
    "endpoint": "hunyuan-image-3.0",
    "provider": "Hunyuan",
    "kind": "text-to-image"
  },
  {
    "id": "leonardoai-phoenix-1.0",
    "name": "Leonardoai Phoenix 1.0",
    "endpoint": "leonardoai-phoenix-1.0",
    "provider": "Leonardo AI",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "16:9",
      "9:16",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "2:3",
      "3:2"
    ]
  },
  {
    "id": "leonardoai-lucid-origin",
    "name": "Leonardoai Lucid Origin",
    "endpoint": "leonardoai-lucid-origin",
    "provider": "Leonardo AI",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "16:9",
      "9:16",
      "3:4",
      "4:3",
      "4:5",
      "5:4",
      "2:3",
      "3:2"
    ]
  },
  {
    "id": "reve-text-to-image",
    "name": "Reve Text To Image",
    "endpoint": "reve-text-to-image",
    "provider": "Wavespeed",
    "kind": "text-to-image",
    "aspectRatios": [
      "21:9",
      "16:9",
      "4:3",
      "1:1",
      "3:4",
      "9:16",
      "9:21"
    ]
  },
  {
    "id": "grok-imagine-text-to-image",
    "name": "Grok Imagine Text To Image",
    "endpoint": "grok-imagine-text-to-image",
    "provider": "xAI",
    "kind": "text-to-image",
    "aspectRatios": [
      "9:16",
      "16:9",
      "2:3",
      "3:2",
      "1:1"
    ]
  },
  {
    "id": "nano-banana-pro",
    "name": "Nano Banana Pro",
    "endpoint": "nano-banana-pro",
    "provider": "Google",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "3:4",
      "4:3",
      "9:16",
      "16:9",
      "3:2",
      "2:3",
      "5:4",
      "4:5",
      "21:9"
    ]
  },
  {
    "id": "kling-o1-text-to-image",
    "name": "Kling O1 Text To Image",
    "endpoint": "kling-o1-text-to-image",
    "provider": "Kling AI",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "2:3",
      "3:2",
      "21:9"
    ]
  },
  {
    "id": "z-image-turbo",
    "name": "Z Image Turbo",
    "endpoint": "z-image-turbo",
    "provider": "Alibaba",
    "kind": "text-to-image"
  },
  {
    "id": "flux-2-dev",
    "name": "Flux 2 Dev",
    "endpoint": "flux-2-dev",
    "provider": "Black Forest Labs",
    "kind": "text-to-image"
  },
  {
    "id": "flux-2-flex",
    "name": "Flux 2 Flex",
    "endpoint": "flux-2-flex",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "2:3",
      "3:2"
    ]
  },
  {
    "id": "flux-2-pro",
    "name": "Flux 2 Pro",
    "endpoint": "flux-2-pro",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "2:3",
      "3:2"
    ]
  },
  {
    "id": "vidu-q2-text-to-image",
    "name": "Vidu Q2 Text To Image",
    "endpoint": "vidu-q2-text-to-image",
    "provider": "Vidu",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "3:4",
      "2:3",
      "3:2",
      "21:9"
    ]
  },
  {
    "id": "bytedance-seedream-v4.5",
    "name": "Bytedance Seedream V4.5",
    "endpoint": "bytedance-seedream-v4.5",
    "provider": "ByteDance",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4",
      "2:3",
      "3:2",
      "21:9"
    ]
  },
  {
    "id": "gpt-image-1.5",
    "name": "Gpt Image 1.5",
    "endpoint": "gpt-image-1.5",
    "provider": "OpenAI",
    "kind": "text-to-image",
    "aspectRatios": [
      "1:1",
      "2:3",
      "3:2"
    ]
  },
  {
    "id": "gpt-image-2",
    "name": "Gpt Image 2",
    "endpoint": "gpt-image-2-text-to-image",
    "provider": "OpenAI",
    "kind": "text-to-image",
    "aspectRatios": [
      "auto",
      "1:1",
      "16:9",
      "9:16",
      "4:3",
      "3:4"
    ]
  },
  {
    "id": "wan2.6-text-to-image",
    "name": "Wan2.6 Text To Image",
    "endpoint": "wan2.6-text-to-image",
    "provider": "Alibaba",
    "kind": "text-to-image"
  },
  {
    "id": "qwen-text-to-image-2512",
    "name": "Qwen Text To Image 2512",
    "endpoint": "qwen-text-to-image-2512",
    "provider": "Alibaba",
    "kind": "text-to-image"
  },
  {
    "id": "flux-2-klein-4b",
    "name": "Flux 2 Klein 4b",
    "endpoint": "flux-2-klein-4b",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "3:4",
      "4:3",
      "21:9",
      "9:21"
    ]
  },
  {
    "id": "flux-2-klein-9b",
    "name": "Flux 2 Klein 9b",
    "endpoint": "flux-2-klein-9b",
    "provider": "Black Forest Labs",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "3:4",
      "4:3",
      "21:9",
      "9:21"
    ]
  },
  {
    "id": "z-image-base",
    "name": "Z Image Base",
    "endpoint": "z-image-base",
    "provider": "Alibaba",
    "kind": "text-to-image",
    "aspectRatios": [
      "16:9",
      "9:16",
      "1:1",
      "3:4",
      "4:3",
      "21:9",
      "9:21"
    ]
  }
];

export function listStudioModels(kind?: string): StudioModel[] {
  if (!kind) return STUDIO_MODELS;
  return STUDIO_MODELS.filter(m => m.kind === kind);
}

export function findStudioModel(id: string): StudioModel | undefined {
  const q = id.trim().toLowerCase();
  return STUDIO_MODELS.find(m => m.id.toLowerCase() === q)
    ?? STUDIO_MODELS.find(m => m.endpoint.toLowerCase() === q)
    ?? STUDIO_MODELS.find(m => m.name.toLowerCase() === q);
}
