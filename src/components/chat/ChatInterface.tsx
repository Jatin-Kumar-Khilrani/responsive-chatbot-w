import { useState, useRef, useEffect } from 'react'
import { ArrowLeft, PaperPlaneTilt, Paperclip, Microphone, Camera, MapPin, Warning, ShieldCheck } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useKV } from '../../hooks/useKV'
import { toast } from 'sonner'
import { useAIService } from '../ai/EnhancedAIService'
import { handleKVError, sanitizeKVKey, isValidChatId } from '../../utils/errorHandling'
import { EnhancedKV } from '../../utils/kvStorage'

// Helper function for fallback suggestions
function getFallbackSuggestion(message: string): string {
  const lowerMessage = message.toLowerCase()
  
  if (lowerMessage.includes('route') || lowerMessage.includes('traffic') || lowerMessage.includes('direction')) {
    return '\n\n🗺️ **For route planning:** Try "I need to go from [location] to [destination]" or check Google Maps/Ola Maps for live navigation.'
  }
  
  if (lowerMessage.includes('bill') || lowerMessage.includes('payment') || lowerMessage.includes('electricity') || lowerMessage.includes('water')) {
    return '\n\n💰 **For bill processing:** Upload a clear photo of your bill, or try describing the bill details (amount, due date, provider).'
  }
  
  if (lowerMessage.includes('summary') || lowerMessage.includes('group') || lowerMessage.includes('@sahaay')) {
    return '\n\n👥 **For group features:** Try "@Sahaay summary of last 3 days" or "summarize recent messages" for conversation insights.'
  }
  
  if (lowerMessage.includes('weather') || lowerMessage.includes('temperature')) {
    return '\n\n🌤️ **For weather:** Check weather apps or try "What\'s the weather like in [city]?"'
  }
  
  if (lowerMessage.includes('translate') || lowerMessage.includes('meaning')) {
    return '\n\n🌍 **For translation:** Try Google Translate or specify the languages: "Translate [text] from [language] to [language]"'
  }
  
  return '\n\n💡 **Try asking about:** Routes, bills, weather, translations, or group summaries. Be specific for better results!'
}

interface Message {
  id: string
  content: string
  sender: 'user' | 'ai'
  timestamp: string
  type: 'text' | 'image' | 'location' | 'bill'
  metadata?: {
    confidence?: number
    needsPermission?: string
    actionItems?: string[]
    disclaimer?: string
  }
}

interface ChatInterfaceProps {
  chatId: string
  userConsents: Record<string, boolean>
  onBack: () => void
  onChatUpdate?: (chatId: string, lastMessage: string) => void
}

export function ChatInterface({ chatId, userConsents, onBack, onChatUpdate }: ChatInterfaceProps) {
  const [message, setMessage] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [isSending, setIsSending] = useState(false)
  
  // Validate and sanitize chat ID
  if (!isValidChatId(chatId)) {
    console.warn('Invalid chat ID format:', chatId)
  }
  
  const sanitizedChatId = sanitizeKVKey(chatId)
  const kvKey = `chat-messages-${sanitizedChatId}`
  
  // Use a more defensive approach to KV storage with error handling
  const [messages, setMessages] = useKV<Message[]>(kvKey, [])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const aiService = useAIService()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    // Initialize AI service with current config
    const initializeAI = async () => {
      try {
        await aiService.initializeConfig()
      } catch (error) {
        console.error('Failed to initialize AI service:', error)
      }
    }
    initializeAI()
  }, [aiService])

  // Add debug logging for KV storage
  useEffect(() => {
    console.log('ChatInterface mounted with:', {
      chatId,
      sanitizedChatId,
      kvKey,
      messagesLength: messages?.length || 0
    })
  }, [chatId, sanitizedChatId, kvKey, messages])

  const sendMessage = async () => {
    if (!message.trim() || isSending) return

    setIsSending(true)
    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      content: message.trim(),
      sender: 'user',
      timestamp: new Date().toISOString(),
      type: 'text'
    }

    try {
      console.log('Attempting to save user message to KV key:', kvKey)
      setMessages(prev => {
        const currentMessages = prev || []
        console.log('Current messages length:', currentMessages.length)
        const updatedMessages = [...currentMessages, userMessage]
        console.log('Updated messages length:', updatedMessages.length)
        return updatedMessages
      })
    } catch (error) {
      console.error('KV Storage Error Details:', error)
      const appError = handleKVError(error, 'add user message', kvKey)
      toast.error(appError.message)
      setIsSending(false)
      return
    }

    const currentMessage = message.trim()
    setMessage('')
    setIsTyping(true)

    try {
      // Initialize AI service and ensure it's configured
      await aiService.initializeConfig()

      // Use the enhanced AI service for generating responses
      const [moodAnalysis, locationContext] = await Promise.all([
        userConsents.moodDetection ? aiService.detectMood(currentMessage) : Promise.resolve({ mood: 'neutral' as const, confidence: 0, suggestions: [] }),
        userConsents.locationServices ? aiService.getHyperlocalContext('Bangalore', currentMessage) : Promise.resolve({ area: '', suggestions: [] })
      ])

      // Convert messages to AI service format
      const aiServiceMessages = (messages || []).map(msg => ({
        id: msg.id,
        content: msg.content,
        sender: msg.sender === 'user' ? 'user' : 'ai',
        timestamp: new Date(msg.timestamp),
        type: msg.type,
        metadata: msg.metadata
      }))

      const aiResponseContent = await aiService.generateResponse(
        currentMessage,
        {
          mood: moodAnalysis,
          location: locationContext,
          messageHistory: aiServiceMessages as any,
          isGroupMention: currentMessage.toLowerCase().includes('@sahaay'),
          specificRequest: currentMessage
        }
      )

      const aiMessage: Message = {
        id: `msg-${Date.now() + 1}`,
        content: aiResponseContent,
        sender: 'ai',
        timestamp: new Date().toISOString(),
        type: 'text',
        metadata: {
          confidence: moodAnalysis.confidence,
          disclaimer: 'AI-generated response. Verify important information independently.'
        }
      }

      try {
        setMessages(prev => {
          const currentMessages = prev || []
          return [...currentMessages, aiMessage]
        })
        
        // Update the chat's last message in the chat list
        onChatUpdate?.(chatId, aiMessage.content.substring(0, 100))
      } catch (error) {
        const appError = handleKVError(error, 'add AI message')
        toast.error(appError.message)
      }
    } catch (error) {
      console.error('AI response error:', error)
      
      // Provide a fallback response
      const fallbackMessage: Message = {
        id: `msg-${Date.now() + 1}`,
        content: "I'm currently having trouble connecting to the AI service. This could be because:\n\n🔧 **Configuration needed:** Go to Settings → AI Configuration to set up your AI provider\n\n🌐 **Connection issues:** Check your internet connection\n\n⚙️ **Service temporarily unavailable:** Please try again in a moment\n\n**Based on your message, here are some immediate suggestions:**" + getFallbackSuggestion(currentMessage),
        sender: 'ai',
        timestamp: new Date().toISOString(),
        type: 'text',
        metadata: {
          confidence: 0.1,
          disclaimer: 'This is a fallback response due to AI service unavailability. Please configure your AI provider in Settings for full functionality.'
        }
      }
      
      try {
        setMessages(prev => {
          const currentMessages = prev || []
          return [...currentMessages, fallbackMessage]
        })
      } catch (kvError) {
        const appError = handleKVError(kvError, 'add fallback message')
        toast.error(appError.message)
      }
      
      toast.error('Failed to get AI response. Using fallback response.')
    } finally {
      setIsTyping(false)
      setIsSending(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
    // Escape key to clear message
    if (e.key === 'Escape') {
      setMessage('')
    }
  }

  const handleFileUpload = () => {
    fileInputRef.current?.click()
  }

  const processFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (file.type.startsWith('image/')) {
      processImageUpload(file)
    }
  }

  const processImageUpload = async (file: File) => {
    try {
      const imageMessage: Message = {
        id: `msg-${Date.now()}`,
        content: `📷 Image uploaded: ${file.name}`,
        sender: 'user',
        timestamp: new Date().toISOString(),
        type: 'image'
      }

      try {
        setMessages(prev => {
          const currentMessages = prev || []
          return [...currentMessages, imageMessage]
        })
      } catch (error) {
        const appError = handleKVError(error, 'add image message')
        toast.error(appError.message)
        return
      }

      setIsTyping(true)

      // Validate file size (max 10MB)
      if (file.size > 10 * 1024 * 1024) {
        throw new Error('File size too large. Please select an image under 10MB.')
      }

      // Validate file type
      if (!file.type.startsWith('image/')) {
        throw new Error('Invalid file type. Please select an image file.')
      }

      // Simulate bill processing
      setTimeout(() => {
        const billResponse: Message = {
          id: `msg-${Date.now() + 1}`,
          content: "I can see this is a BESCOM electricity bill. Here's what I found:\n\n💡 **Bill Amount**: ₹734\n📅 **Due Date**: 22 Sep 2024\n🏠 **Service Connection**: 1234567890\n\nWould you like me to create a UPI payment link or set a reminder?",
          sender: 'ai',
          timestamp: new Date().toISOString(),
          type: 'text',
          metadata: {
            confidence: 0.95,
            actionItems: ['Create UPI Payment Link', 'Set Reminder', 'View Bill Details'],
            disclaimer: 'Bill processing is automated. Please verify details before payment.'
          }
        }
        
        try {
          setMessages(prev => {
            const currentMessages = prev || []
            return [...currentMessages, billResponse]
          })
        } catch (error) {
          const appError = handleKVError(error, 'add bill response')
          toast.error(appError.message)
        }
        
        setIsTyping(false)
      }, 2000)
    } catch (error) {
      setIsTyping(false)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      toast.error(errorMessage)
      
      // Add error message to chat
      const errorResponse: Message = {
        id: `msg-${Date.now() + 1}`,
        content: `❌ Error processing image: ${errorMessage}`,
        sender: 'ai',
        timestamp: new Date().toISOString(),
        type: 'text',
        metadata: {
          confidence: 0,
          disclaimer: 'Error occurred during file processing.'
        }
      }
      
      try {
        setMessages(prev => {
          const currentMessages = prev || []
          return [...currentMessages, errorResponse]
        })
      } catch (kvError) {
        const appError = handleKVError(kvError, 'add error message')
        console.error(appError.message)
      }
    }
  }

  return (
    <div className="chat-container w-full h-full flex flex-col bg-background">
      {/* Header - Fixed height */}
      <div className="chat-header flex-shrink-0 p-3 sm:p-4 border-b border-border bg-card" role="banner">
        <div className="flex items-center gap-2 sm:gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Go back to chat list" className="sm:hidden">
            <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-sm sm:text-base truncate">Sahaay Assistant</h2>
            <div className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm text-muted-foreground">
              <ShieldCheck className="w-3 h-3 sm:w-4 sm:h-4 shrink-0" />
              <span className="truncate">Privacy-protected conversation</span>
            </div>
          </div>
          <Badge variant="secondary" className="text-xs shrink-0">
            AI
          </Badge>
        </div>
      </div>

      {/* Messages - Flexible height with scroll */}
      <div className="chat-messages-area flex-1 overflow-y-auto p-2 sm:p-4 space-y-3 sm:space-y-4 min-h-0" role="main" aria-live="polite" aria-label="Chat messages">
        {messages?.length === 0 && (
          <div className="text-center py-4 sm:py-8 px-2">
            <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-3 sm:mb-4">
              <ShieldCheck className="w-6 h-6 sm:w-8 sm:h-8 text-primary" />
            </div>
            <h3 className="font-semibold mb-2 text-sm sm:text-base">Privacy-First AI Assistant</h3>
            <p className="text-muted-foreground text-xs sm:text-sm max-w-md mx-auto mb-4">
              I'm here to help with routes, bills, group summaries, and more. All interactions are consent-based and privacy-protected.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 max-w-2xl mx-auto text-xs">
              <div className="p-2 sm:p-3 bg-muted rounded cursor-pointer hover:bg-muted/80 transition-colors"
                   onClick={() => setMessage("I need to go from Koramangala to Whitefield by 9 AM")}>
                <strong>📍 Route Planning:</strong><br className="hidden xs:block" /> 
                <span className="xs:hidden">Route help</span>
                <span className="hidden xs:inline">"I need to go from Koramangala to Whitefield by 9 AM"</span>
              </div>
              <div className="p-2 sm:p-3 bg-muted rounded cursor-pointer hover:bg-muted/80 transition-colors"
                   onClick={() => fileInputRef.current?.click()}>
                <strong>💰 Bill Processing:</strong><br className="hidden xs:block" />
                <span className="xs:hidden">Upload bills</span>
                <span className="hidden xs:inline">Click to upload bill photos for payment assistance</span>
              </div>
              <div className="p-2 sm:p-3 bg-muted rounded cursor-pointer hover:bg-muted/80 transition-colors"
                   onClick={() => setMessage("@Sahaay summary of last 2 days")}>
                <strong>👥 Group Summary:</strong><br className="hidden xs:block" />
                <span className="xs:hidden">Chat summaries</span>
                <span className="hidden xs:inline">"@Sahaay summary of last 2 days"</span>
              </div>
              <div className="p-2 sm:p-3 bg-muted rounded cursor-pointer hover:bg-muted/80 transition-colors"
                   onClick={() => setMessage("How's the weather in Bangalore today?")}>
                <strong>🌤️ Quick Questions:</strong><br className="hidden xs:block" />
                <span className="xs:hidden">Weather & more</span>
                <span className="hidden xs:inline">"How's the weather in Bangalore today?"</span>
              </div>
            </div>
          </div>
        )}

        {messages?.map((msg) => (
          <MessageBubble key={msg.id} message={msg} userConsents={userConsents} />
        ))}

        {isTyping && (
          <div className="flex items-start gap-2 sm:gap-3">
            <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-3 h-3 sm:w-4 sm:h-4 text-primary" />
            </div>
            <div className="bg-muted p-2 sm:p-3 rounded-lg max-w-xs">
              <div className="flex space-x-1">
                <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area - Fixed height */}
      <div className="chat-input-area flex-shrink-0 p-2 sm:p-4 border-t border-border bg-card" role="form" aria-label="Message input">
        <div className="flex items-end gap-2 mb-2">
          <Button
            variant="outline"
            size="icon"
            onClick={handleFileUpload}
            className="flex-shrink-0 h-9 w-9 sm:h-10 sm:w-10"
            aria-label="Attach file"
          >
            <Paperclip className="w-3 h-3 sm:w-4 sm:h-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Message Sahaay..."
              className="resize-none h-9 sm:h-10 text-sm"
              aria-label="Type your message"
            />
          </div>
          <Button 
            onClick={sendMessage} 
            disabled={!message.trim() || isSending} 
            aria-label="Send message"
            size="icon"
            className={`flex-shrink-0 h-9 w-9 sm:h-10 sm:w-10 ${isSending ? 'animate-pulse' : ''}`}
          >
            <PaperPlaneTilt className="w-3 h-3 sm:w-4 sm:h-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground text-center leading-tight">
          AI responses may contain errors. Not for medical/financial/legal advice.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={processFileUpload}
        className="hidden"
      />
    </div>
  )
}

function MessageBubble({ message, userConsents }: { message: Message; userConsents: Record<string, boolean> }) {
  const isUser = message.sender === 'user'

  return (
    <div className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
        {isUser ? (
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary to-accent" />
        ) : (
          <ShieldCheck className="w-4 h-4 text-primary" />
        )}
      </div>
      <div className={`max-w-xs lg:max-w-md ${isUser ? 'text-right' : ''}`}>
        <div
          className={`p-3 rounded-lg ${
            isUser
              ? 'bg-primary text-primary-foreground ml-auto'
              : 'bg-muted'
          }`}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
          
          {message.metadata?.actionItems && (
            <div className="mt-3 space-y-1">
              {message.metadata.actionItems.map((action, index) => (
                <Button
                  key={index}
                  variant="outline"
                  size="sm"
                  className="mr-2 mb-1"
                  onClick={() => toast.info(`Action: ${action}`)}
                >
                  {action}
                </Button>
              ))}
            </div>
          )}
        </div>
        
        {message.metadata?.disclaimer && (
          <Alert className="mt-2 max-w-md">
            <Warning className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {message.metadata.disclaimer}
            </AlertDescription>
          </Alert>
        )}
        
        <p className="text-xs text-muted-foreground mt-1">
          {new Date(message.timestamp).toLocaleTimeString()}
          {message.metadata?.confidence && (
            <span className="ml-2">
              • Confidence: {Math.round(message.metadata.confidence * 100)}%
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

