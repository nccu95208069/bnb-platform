"use client";

import { useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { useWizardStore } from "@/stores/wizardStore";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  Link as LinkIcon,
  Undo,
  Redo,
} from "lucide-react";
import { cn } from "@/lib/utils";

const fonts = [
  { value: "default", label: "預設字型" },
  { value: "serif", label: "襯線體 (Serif)" },
  { value: "sans-serif", label: "無襯線體 (Sans-serif)" },
  { value: "monospace", label: "等寬字型 (Monospace)" },
];

function ToolbarButton({
  onClick,
  isActive,
  children,
  title,
}: {
  onClick: () => void;
  isActive?: boolean;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded p-1.5 transition-colors hover:bg-accent",
        isActive && "bg-accent text-accent-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function StepContent() {
  const content = useWizardStore((s) => s.content);
  const setContent = useWizardStore((s) => s.setContent);
  const nextStep = useWizardStore((s) => s.nextStep);
  const prevStep = useWizardStore((s) => s.prevStep);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { class: "text-primary underline" },
      }),
    ],
    content: content.body,
    onUpdate: ({ editor }) => {
      setContent({ body: editor.getHTML() });
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none min-h-[200px] p-4 focus:outline-none",
      },
    },
  });

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("輸入連結 URL", previousUrl);
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  const isValid = content.title.trim() !== "" && content.body.trim() !== "";

  const fontClass =
    content.fontFamily === "serif"
      ? "font-serif"
      : content.fontFamily === "monospace"
        ? "font-mono"
        : content.fontFamily === "sans-serif"
          ? "font-sans"
          : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>訊息內容</CardTitle>
        <CardDescription>
          撰寫您想傳達的訊息。支援文字格式設定。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="content-title">訊息標題 *</Label>
              <Input
                id="content-title"
                placeholder="為這封訊息取個標題"
                value={content.title}
                onChange={(e) => setContent({ title: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="content-font">字型選擇</Label>
              <Select
                value={content.fontFamily}
                onValueChange={(value) => setContent({ fontFamily: value })}
              >
                <SelectTrigger className="w-full" id="content-font">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fonts.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>訊息內文 *</Label>
            <div className={cn("rounded-md border", fontClass)}>
              {editor && (
                <div className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5">
                  <ToolbarButton
                    onClick={() => editor.chain().focus().toggleBold().run()}
                    isActive={editor.isActive("bold")}
                    title="粗體"
                  >
                    <Bold className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton
                    onClick={() => editor.chain().focus().toggleItalic().run()}
                    isActive={editor.isActive("italic")}
                    title="斜體"
                  >
                    <Italic className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton
                    onClick={() =>
                      editor.chain().focus().toggleHeading({ level: 2 }).run()
                    }
                    isActive={editor.isActive("heading", { level: 2 })}
                    title="標題"
                  >
                    <Heading2 className="h-4 w-4" />
                  </ToolbarButton>
                  <div className="mx-1 h-5 w-px bg-border" />
                  <ToolbarButton
                    onClick={() =>
                      editor.chain().focus().toggleBulletList().run()
                    }
                    isActive={editor.isActive("bulletList")}
                    title="無序列表"
                  >
                    <List className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton
                    onClick={() =>
                      editor.chain().focus().toggleOrderedList().run()
                    }
                    isActive={editor.isActive("orderedList")}
                    title="有序列表"
                  >
                    <ListOrdered className="h-4 w-4" />
                  </ToolbarButton>
                  <div className="mx-1 h-5 w-px bg-border" />
                  <ToolbarButton
                    onClick={setLink}
                    isActive={editor.isActive("link")}
                    title="連結"
                  >
                    <LinkIcon className="h-4 w-4" />
                  </ToolbarButton>
                  <div className="mx-1 h-5 w-px bg-border" />
                  <ToolbarButton
                    onClick={() => editor.chain().focus().undo().run()}
                    title="復原"
                  >
                    <Undo className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton
                    onClick={() => editor.chain().focus().redo().run()}
                    title="重做"
                  >
                    <Redo className="h-4 w-4" />
                  </ToolbarButton>
                </div>
              )}
              <EditorContent editor={editor} />
            </div>
          </div>

          <div className="flex justify-between">
            <Button variant="outline" onClick={prevStep}>
              上一步
            </Button>
            <Button onClick={nextStep} disabled={!isValid}>
              下一步
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
