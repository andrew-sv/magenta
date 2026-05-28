export type WorkflowParams = {
  ckptName: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
};

export type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export type ComfyWorkflow = Record<string, ComfyNode>;

function sdxlTurbo(p: WorkflowParams): ComfyWorkflow {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1.0,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: p.ckptName },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: p.width, height: p.height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: p.prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: p.negativePrompt, clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "magenta", images: ["8", 0] },
    },
  };
}

function fluxSchnell(p: WorkflowParams): ComfyWorkflow {
  // FLUX schnell is distilled; cfg=1 means no classifier-free guidance,
  // so the negative branch is functionally inert but still required by KSampler.
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: p.ckptName },
    },
    "5": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: p.width, height: p.height, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: p.prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: "", clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "magenta", images: ["8", 0] },
    },
  };
}

export const WORKFLOWS = {
  "sdxl-turbo": sdxlTurbo,
  "flux-schnell": fluxSchnell,
} as const;

export type WorkflowName = keyof typeof WORKFLOWS;

// ---------- Animation workflows ----------

export type AnimationWorkflowParams = {
  ckptName: string;
  motionModule: string;
  motionScale: number;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  frames: number;
  fps: number;
};

function animatediffSd15(p: AnimationWorkflowParams): ComfyWorkflow {
  // SD1.5 + AnimateDiff-Evolved. Context length = frame count for short clips
  // (≤ 16 frames sample in a single forward pass; longer clips would need
  // sliding-window context). ADE_AnimateDiffCombine emits the GIF directly so
  // we don't need VideoHelperSuite.
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: p.ckptName },
    },
    "2": {
      class_type: "ADE_LoadAnimateDiffModel",
      inputs: { model_name: p.motionModule },
    },
    "3": {
      class_type: "ADE_MultivalDynamic",
      inputs: { float_val: p.motionScale },
    },
    "4": {
      class_type: "ADE_ApplyAnimateDiffModel",
      inputs: {
        motion_model: ["2", 0],
        start_percent: 0.0,
        end_percent: 1.0,
        scale_multival: ["3", 0],
      },
    },
    "5": {
      class_type: "ADE_StandardStaticContextOptions",
      inputs: {
        context_length: Math.min(p.frames, 16),
        context_overlap: 4,
      },
    },
    "6": {
      class_type: "ADE_UseEvolvedSampling",
      inputs: {
        model: ["1", 0],
        beta_schedule: "sqrt_linear (AnimateDiff)",
        m_models: ["4", 0],
        context_options: ["5", 0],
      },
    },
    "7": {
      class_type: "EmptyLatentImage",
      inputs: { width: p.width, height: p.height, batch_size: p.frames },
    },
    "8": {
      class_type: "CLIPTextEncode",
      inputs: { text: p.prompt, clip: ["1", 1] },
    },
    "9": {
      class_type: "CLIPTextEncode",
      inputs: { text: p.negativePrompt, clip: ["1", 1] },
    },
    "10": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1.0,
        model: ["6", 0],
        positive: ["8", 0],
        negative: ["9", 0],
        latent_image: ["7", 0],
      },
    },
    "11": {
      class_type: "VAEDecode",
      inputs: { samples: ["10", 0], vae: ["1", 2] },
    },
    "12": {
      class_type: "ADE_AnimateDiffCombine",
      inputs: {
        images: ["11", 0],
        frame_rate: p.fps,
        loop_count: 0,
        filename_prefix: "magenta",
        format: "image/gif",
        pingpong: false,
        save_image: true,
      },
    },
  };
}

export const ANIMATION_WORKFLOWS = {
  "animatediff-sd15": animatediffSd15,
} as const;

export type AnimationWorkflowName = keyof typeof ANIMATION_WORKFLOWS;

// ---------- Audio (music) workflows ----------

export type AudioWorkflowParams = {
  ckptName: string;
  /** Style/genre/mood tags (ACE-Step) or text prompt (Stable Audio). */
  prompt: string;
  /** Lyrics for ACE-Step; ignored by instrumental models. */
  lyrics: string;
  negativePrompt: string;
  durationSeconds: number;
  steps: number;
  cfg: number;
  seed: number;
};

function aceStep(p: AudioWorkflowParams): ComfyWorkflow {
  // ACE-Step v1 via ComfyUI's native audio nodes. `tags` carries the style
  // prompt; `lyrics` is sung. ModelSamplingSD3 shift=5 matches ComfyUI's
  // reference workflow. Negative is a zeroed-out copy of the positive
  // conditioning (ACE-Step has no separate negative text encoder).
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: p.ckptName },
    },
    "2": {
      class_type: "EmptyAceStepLatentAudio",
      inputs: { seconds: p.durationSeconds, batch_size: 1 },
    },
    "3": {
      class_type: "TextEncodeAceStepAudio",
      inputs: {
        clip: ["1", 1],
        tags: p.prompt,
        lyrics: p.lyrics,
        lyrics_strength: 1.0,
      },
    },
    "4": {
      class_type: "ConditioningZeroOut",
      inputs: { conditioning: ["3", 0] },
    },
    "5": {
      class_type: "ModelSamplingSD3",
      inputs: { model: ["1", 0], shift: 5.0 },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
        model: ["5", 0],
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["2", 0],
      },
    },
    "7": {
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["6", 0], vae: ["1", 2] },
    },
    "8": {
      class_type: "SaveAudio",
      inputs: { audio: ["7", 0], filename_prefix: "magenta" },
    },
  };
}

/** Companion text encoder Stable Audio Open needs in ComfyUI/models/text_encoders/. */
const STABLE_AUDIO_T5 = "t5_base.safetensors";

function stableAudio(p: AudioWorkflowParams): ComfyWorkflow {
  // Stable Audio Open: text-conditioned instrumental/SFX, no lyrics. Its
  // checkpoint does NOT bundle a text encoder — ComfyUI loads t5_base via a
  // separate CLIPLoader (type "stable_audio"). MODEL and VAE come from the
  // checkpoint; CLIP comes from the loader.
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: p.ckptName },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: STABLE_AUDIO_T5, type: "stable_audio" },
    },
    "3": {
      class_type: "EmptyLatentAudio",
      inputs: { seconds: p.durationSeconds, batch_size: 1 },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: p.prompt, clip: ["2", 0] },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: p.negativePrompt, clip: ["2", 0] },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "dpmpp_3m_sde_gpu",
        scheduler: "exponential",
        denoise: 1.0,
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["3", 0],
      },
    },
    "7": {
      class_type: "VAEDecodeAudio",
      inputs: { samples: ["6", 0], vae: ["1", 2] },
    },
    "8": {
      class_type: "SaveAudio",
      inputs: { audio: ["7", 0], filename_prefix: "magenta" },
    },
  };
}

export const AUDIO_WORKFLOWS = {
  "ace-step": aceStep,
  "stable-audio": stableAudio,
} as const;

export type AudioWorkflowName = keyof typeof AUDIO_WORKFLOWS;
