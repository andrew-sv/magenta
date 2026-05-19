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
