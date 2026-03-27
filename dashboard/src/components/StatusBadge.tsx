interface StatusBadgeProps {
  status: string;
  size?: "sm" | "md";
}

const colorMap: Record<string, { bg: string; text: string; dot: string }> = {
  active: { bg: "bg-green-500/10", text: "text-green-400", dot: "bg-green-400" },
  running: { bg: "bg-green-500/10", text: "text-green-400", dot: "bg-green-400" },
  success: { bg: "bg-green-500/10", text: "text-green-400", dot: "bg-green-400" },
  error: { bg: "bg-red-500/10", text: "text-red-400", dot: "bg-red-400" },
  failed: { bg: "bg-red-500/10", text: "text-red-400", dot: "bg-red-400" },
  paused: { bg: "bg-yellow-500/10", text: "text-yellow-400", dot: "bg-yellow-400" },
  completed: { bg: "bg-blue-500/10", text: "text-blue-400", dot: "bg-blue-400" },
};

const defaultColor = { bg: "bg-gray-500/10", text: "text-gray-400", dot: "bg-gray-400" };

export default function StatusBadge({ status, size = "sm" }: StatusBadgeProps) {
  const colors = colorMap[status.toLowerCase()] ?? defaultColor;
  const sizeClasses = size === "sm" ? "text-xs px-2 py-0.5" : "text-sm px-2.5 py-1";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${colors.bg} ${colors.text} ${sizeClasses}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} />
      {status}
    </span>
  );
}
