const development = ["development", "fixtures", "test"].includes(
  import.meta.env.MODE,
);

export const EDITOR_STORAGE_PREFIX = development
  ? "windstone-editor"
  : "windstone-production-editor";
export const RECORDER_DATABASE = development
  ? "windstone-recorder"
  : "windstone-production-recorder";
