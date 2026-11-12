/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "var(--um-accent)",
          soft: "var(--um-accent-soft)",
        },
        // shadcn-style surface tokens used by MacHealthCard / AgentsDashboard.
        // Mapped onto the app's own --um-* design tokens so dark mode flips
        // them via the existing `.dark` block in globals.css.
        card: "rgb(var(--um-card) / <alpha-value>)",
        muted: {
          DEFAULT: "rgb(var(--um-muted) / <alpha-value>)",
          foreground: "rgb(var(--um-muted-foreground) / <alpha-value>)",
        },
        border: "rgb(var(--um-border) / <alpha-value>)",
      },
      borderRadius: {
        "um-lg": "var(--um-radius-lg)",
        "um-xl": "var(--um-radius-xl)",
      },
    },
  },
  plugins: [],
};
