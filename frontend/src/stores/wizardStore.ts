import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export interface RecipientData {
  name: string;
  email: string;
  relationship: string;
  note: string;
}

export interface ContentData {
  title: string;
  body: string;
  fontFamily: string;
}

export interface MediaFile {
  id: string;
  file?: File;
  url: string;
  name: string;
  size: number;
  type: string;
  status: "uploading" | "uploaded" | "error";
}

export interface WizardState {
  currentStep: WizardStep;
  recipient: RecipientData;
  content: ContentData;
  mediaFiles: MediaFile[];
  accessToken: string | null;
  isDirty: boolean;
  lastSavedAt: string | null;

  setStep: (step: WizardStep) => void;
  nextStep: () => void;
  prevStep: () => void;
  setRecipient: (data: Partial<RecipientData>) => void;
  setContent: (data: Partial<ContentData>) => void;
  addMediaFile: (file: MediaFile) => void;
  removeMediaFile: (id: string) => void;
  updateMediaFile: (id: string, data: Partial<MediaFile>) => void;
  setAccessToken: (token: string) => void;
  markSaved: () => void;
  reset: () => void;
}

const initialRecipient: RecipientData = {
  name: "",
  email: "",
  relationship: "",
  note: "",
};

const initialContent: ContentData = {
  title: "",
  body: "",
  fontFamily: "default",
};

export const useWizardStore = create<WizardState>()(
  persist(
    (set) => ({
      currentStep: 1,
      recipient: { ...initialRecipient },
      content: { ...initialContent },
      mediaFiles: [],
      accessToken: null,
      isDirty: false,
      lastSavedAt: null,

      setStep: (step) => set({ currentStep: step }),

      nextStep: () =>
        set((state) => ({
          currentStep: Math.min(state.currentStep + 1, 5) as WizardStep,
        })),

      prevStep: () =>
        set((state) => ({
          currentStep: Math.max(state.currentStep - 1, 1) as WizardStep,
        })),

      setRecipient: (data) =>
        set((state) => ({
          recipient: { ...state.recipient, ...data },
          isDirty: true,
        })),

      setContent: (data) =>
        set((state) => ({
          content: { ...state.content, ...data },
          isDirty: true,
        })),

      addMediaFile: (file) =>
        set((state) => ({
          mediaFiles: [...state.mediaFiles, file],
          isDirty: true,
        })),

      removeMediaFile: (id) =>
        set((state) => ({
          mediaFiles: state.mediaFiles.filter((f) => f.id !== id),
          isDirty: true,
        })),

      updateMediaFile: (id, data) =>
        set((state) => ({
          mediaFiles: state.mediaFiles.map((f) =>
            f.id === id ? { ...f, ...data } : f
          ),
        })),

      setAccessToken: (token) => set({ accessToken: token }),

      markSaved: () =>
        set({ isDirty: false, lastSavedAt: new Date().toISOString() }),

      reset: () =>
        set({
          currentStep: 1,
          recipient: { ...initialRecipient },
          content: { ...initialContent },
          mediaFiles: [],
          accessToken: null,
          isDirty: false,
          lastSavedAt: null,
        }),
    }),
    {
      name: "wizard-draft",
      partialize: (state) => ({
        currentStep: state.currentStep,
        recipient: state.recipient,
        content: state.content,
        mediaFiles: state.mediaFiles.map(({ file, ...rest }) => rest),
        lastSavedAt: state.lastSavedAt,
      }),
    }
  )
);
