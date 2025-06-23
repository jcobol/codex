use crate::models::{ResponseItem, ContentItem};
use crate::token_metering::count_text_tokens;

pub struct PromptAssembler {
    max_tokens: usize,
    keep_messages: usize,
    summary: String,
    history: Vec<ResponseItem>,
}

impl PromptAssembler {
    pub fn new(max_tokens: usize, keep_messages: usize) -> Self {
        Self { max_tokens, keep_messages, summary: String::new(), history: Vec::new() }
    }

    pub fn push(&mut self, item: ResponseItem) {
        self.history.push(item);
    }

    fn summarize_item(item: &ResponseItem) -> String {
        match item {
            ResponseItem::Message { role, content } => {
                let mut text = String::new();
                for c in content {
                    match c {
                        ContentItem::InputText { text: t } | ContentItem::OutputText { text: t } => {
                            text.push_str(t);
                        }
                        _ => {}
                    }
                }
                let text = text.replace('\n', " ");
                let snippet = if text.len() > 40 { format!("{}…", &text[..40]) } else { text };
                format!("{}: {}", role, snippet)
            }
            _ => String::new(),
        }
    }

    fn count_tokens(&self, messages: &[ResponseItem]) -> usize {
        let mut count = 0;
        for m in messages {
            if let ResponseItem::Message { content, .. } = m {
                let mut text = String::new();
                for c in content {
                    match c {
                        ContentItem::InputText { text: t } | ContentItem::OutputText { text: t } => {
                            text.push_str(t);
                        }
                        _ => {}
                    }
                }
                count += count_text_tokens("gpt-4", &text).unwrap_or(0);
            }
        }
        count
    }

    pub fn assemble(&mut self) -> Vec<ResponseItem> {
        let mut keep: Vec<ResponseItem> = self.history.iter().cloned().rev().take(self.keep_messages).collect();
        keep.reverse();
        if self.history.len() > self.keep_messages {
            for item in &self.history[0..self.history.len() - self.keep_messages] {
                let s = Self::summarize_item(item);
                if !s.is_empty() {
                    self.summary.push_str(&s);
                    self.summary.push(' ');
                }
            }
        }
        let mut result = Vec::new();
        if !self.summary.trim().is_empty() {
            result.push(ResponseItem::Message {
                role: "system".to_string(),
                content: vec![ContentItem::InputText { text: self.summary.trim().to_string() }],
            });
        }
        result.extend(keep);

        while self.count_tokens(&result) > self.max_tokens && result.len() > 1 {
            let removed = result.remove(1);
            let s = Self::summarize_item(&removed);
            if !s.is_empty() {
                self.summary.push_str(&s);
                self.summary.push(' ');
                result[0] = ResponseItem::Message {
                    role: "system".to_string(),
                    content: vec![ContentItem::InputText { text: self.summary.trim().to_string() }],
                };
            }
        }
        result
    }
}

