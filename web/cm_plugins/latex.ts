import type { Client } from "../client.ts";
import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Range } from "@codemirror/state";
import katex from "katex";

// Widget for inline LaTeX rendering
class InlineLatexWidget extends WidgetType {
  constructor(
    readonly formula: string,
    readonly client: Client,
    readonly pos: number
  ) {
    super();
  }

  override eq(other: InlineLatexWidget) {
    return other.formula === this.formula;
  }

  toDOM() {
    const wrapper = document.createElement("span");
    wrapper.className = "sb-latex-inline";
    
    try {
      katex.render(this.formula, wrapper, {
        displayMode: false,
        throwOnError: false,
        errorColor: "#f44336",
      });
    } catch (error) {
      console.error("KaTeX rendering error:", error);
      wrapper.textContent = `$${this.formula}$`;
      wrapper.classList.add("sb-latex-error");
    }

    // Make it clickable to enable editing
    wrapper.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      if (this.client.dispatchClickEvent) {
        this.client.dispatchClickEvent({
          pos: this.pos,
          page: this.client.currentPage,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey
        });
      }
    });

    return wrapper;
  }

  override ignoreEvent() {
    return false;
  }
}

// Widget for display LaTeX rendering
class DisplayLatexWidget extends WidgetType {
  constructor(
    readonly formula: string,
    readonly client: Client,
    readonly pos: number
  ) {
    super();
  }

  override eq(other: DisplayLatexWidget) {
    return other.formula === this.formula;
  }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "sb-latex-display";
    
    try {
      // Create a separate div to hold KaTeX output to better control styling
      const katexOutput = document.createElement("div");
      katexOutput.className = "sb-latex-katex-output";
      
      katex.render(this.formula, katexOutput, {
        displayMode: true,
        throwOnError: false,
        errorColor: "#f44336",
      });
      
      wrapper.appendChild(katexOutput);
    } catch (error) {
      console.error("KaTeX rendering error:", error);
      wrapper.textContent = `$$${this.formula}$$`;
      wrapper.classList.add("sb-latex-error");
    }

    // Make it clickable to enable editing
    wrapper.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Display LaTeX clicked, navigating to position:", this.pos);
      if (this.client.dispatchClickEvent) {
        this.client.dispatchClickEvent({
          pos: this.pos,
          page: this.client.currentPage,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey
        });
      }
    });

    return wrapper;
  }

  override ignoreEvent() {
    return false;
  }
}

function createLatexDecorations(view: EditorView, client: Client) {
  const widgets: Range<Decoration>[] = [];
  
  // Get all selections to check if LaTeX nodes are part of a selection
  const selections = view.state.selection.ranges;
  const cursorPos = view.state.selection.main.head;
  
  let inlineCount = 0;
  let displayCount = 0;
  
  // Helper function to check if a node is part of any selection
  const isNodeInSelection = (nodeFrom: number, nodeTo: number) => {
    for (const range of selections) {
      // If the selection overlaps with the node at all, consider it selected
      if (range.from < nodeTo && range.to > nodeFrom) {
        console.log(`LaTeX node (${nodeFrom}-${nodeTo}) is in selection (${range.from}-${range.to})`);
        return true;
      }
    }
    return false;
  };
  
  // Process visible ranges to avoid unnecessary work
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        // Check for InlineLatex nodes
        if (node.name === "InlineLatex") {
          const nodeFrom = node.from;
          const nodeTo = node.to;
          
          // Extract the formula without the delimiters
          const formula = view.state.doc.sliceString(nodeFrom + 1, nodeTo - 1);
          
          // Check if cursor is inside the formula or if it's part of a selection
          const isCursorInside = cursorPos >= nodeFrom && cursorPos <= nodeTo;
          const isInSelection = isNodeInSelection(nodeFrom, nodeTo);
          
          if (!isCursorInside && !isInSelection) {
            inlineCount++;
            // Use a replace decoration for inline LaTeX
            const deco = Decoration.replace({
              widget: new InlineLatexWidget(formula, client, nodeFrom + 1),
              inclusive: true,
            });
            widgets.push(deco.range(nodeFrom, nodeTo));
          }
        } 
        // Only handle DisplayLatex nodes if we're not already inside one
        else if (node.name === "DisplayLatex") {
          const nodeFrom = node.from;
          const nodeTo = node.to;
          
          // Check if cursor is inside the formula or if it's part of a selection
          const isCursorInside = cursorPos >= nodeFrom && cursorPos <= nodeTo;
          const isInSelection = isNodeInSelection(nodeFrom, nodeTo);
          
          if (!isCursorInside && !isInSelection) {
            displayCount++;
            
            // Extract the formula text - make sure to only grab the content between $$ and $$
            const text = view.state.doc.sliceString(nodeFrom, nodeTo);
            // Ensure the text starts with $$ and ends with $$
            const match = /^\$\$(.*?)\$\$$/s.exec(text);
            
            if (match) {
              const formula = match[1];
              console.log("Found display LaTeX:", formula);
              
              // Simply replace the entire node with the widget
              const deco = Decoration.replace({
                widget: new DisplayLatexWidget(formula, client, nodeFrom + 2),
                inclusive: true,
                widgetBuffer: false // Disable widget buffer for display LaTeX
              });
              
              widgets.push(deco.range(nodeFrom, nodeTo));
            } else {
              console.error("Failed to extract formula from DisplayLatex node:", text);
            }
          }
        }
      },
    });
  }
  
  console.log(`Created decorations - inline: ${inlineCount}, display: ${displayCount}`);
  return Decoration.set(widgets, true);
}

export const latexPlugin = (client: Client) => {
  console.log("Initializing LaTeX plugin");
  
  // Track if we're currently in a drag operation to prevent flickering
  let isDragging = false;
  let dragEndTimeout: number | null = null;
  
  // Wait until the drag operation completely ends before updating
  const handleDragEnd = (view: EditorView) => {
    if (dragEndTimeout) {
      clearTimeout(dragEndTimeout);
    }
    
    // Set a small timeout to ensure drag is completely finished
    dragEndTimeout = setTimeout(() => {
      console.log("Drag operation ended, updating LaTeX decorations");
      isDragging = false;
      // Force update decorations after drag ends
      view.dispatch({});
    }, 200) as unknown as number;
  };
  
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      
      constructor(view: EditorView) {
        console.log("LaTeX plugin constructor called");
        
        // Setup mouse event handlers to detect drag operations
        view.dom.addEventListener('mousedown', () => {
          isDragging = false;
        });
        
        view.dom.addEventListener('mousemove', (e) => {
          // Only set dragging if button is pressed (drag operation)
          if (e.buttons !== 0) {
            isDragging = true;
          }
        });
        
        view.dom.addEventListener('mouseup', () => {
          if (isDragging) {
            handleDragEnd(view);
          }
        });
        
        this.decorations = createLatexDecorations(view, client);
      }
      
      update(update: ViewUpdate) {
        // Skip updates during drag operations to prevent flickering
        if (isDragging && update.selectionSet && !update.docChanged) {
          return;
        }
        
        if (
          update.docChanged || 
          update.viewportChanged ||
          update.selectionSet ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          if (update.selectionSet) {
            console.log("LaTeX plugin updating decorations due to selection change");
          }
          console.log("LaTeX plugin updating decorations");
          this.decorations = createLatexDecorations(update.view, client);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        // Handle drag end cases when mouse leaves the editor area
        mouseleave: (e, view) => {
          if (isDragging) {
            handleDragEnd(view);
          }
        }
      }
    },
  );
}; 