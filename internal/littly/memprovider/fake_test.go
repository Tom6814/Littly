package memprovider

import (
	"context"

	memprovider "github.com/felinics/memoh/internal/memory/adapters"
	"github.com/felinics/memoh/internal/mcp"
)

type fakeProvider struct{}

func (f *fakeProvider) Type() string { return "fake" }
func (f *fakeProvider) OnBeforeChat(context.Context, memprovider.BeforeChatRequest) (*memprovider.BeforeChatResult, error) {
	return &memprovider.BeforeChatResult{}, nil
}
func (f *fakeProvider) OnAfterChat(context.Context, memprovider.AfterChatRequest) error { return nil }
func (f *fakeProvider) ListTools(context.Context, mcp.ToolSessionContext) ([]mcp.ToolDescriptor, error) {
	return nil, nil
}
func (f *fakeProvider) CallTool(context.Context, mcp.ToolSessionContext, string, map[string]any) (map[string]any, error) {
	return nil, nil
}
func (f *fakeProvider) Add(context.Context, memprovider.AddRequest) (memprovider.SearchResponse, error) {
	return memprovider.SearchResponse{}, nil
}
func (f *fakeProvider) Search(context.Context, memprovider.SearchRequest) (memprovider.SearchResponse, error) {
	return memprovider.SearchResponse{}, nil
}
func (f *fakeProvider) GetAll(context.Context, memprovider.GetAllRequest) (memprovider.SearchResponse, error) {
	return memprovider.SearchResponse{}, nil
}
func (f *fakeProvider) Update(context.Context, memprovider.UpdateRequest) (memprovider.MemoryItem, error) {
	return memprovider.MemoryItem{}, nil
}
func (f *fakeProvider) Delete(context.Context, string, string) (memprovider.DeleteResponse, error) {
	return memprovider.DeleteResponse{}, nil
}
func (f *fakeProvider) DeleteBatch(context.Context, string, []string) (memprovider.DeleteResponse, error) {
	return memprovider.DeleteResponse{}, nil
}
func (f *fakeProvider) DeleteAll(context.Context, memprovider.DeleteAllRequest) (memprovider.DeleteResponse, error) {
	return memprovider.DeleteResponse{}, nil
}
func (f *fakeProvider) Compact(context.Context, map[string]any, float64, int) (memprovider.CompactResult, error) {
	return memprovider.CompactResult{}, nil
}
func (f *fakeProvider) Usage(context.Context, map[string]any) (memprovider.UsageResponse, error) {
	return memprovider.UsageResponse{}, nil
}
