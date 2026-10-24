// Package knowledge owns the workspace knowledge repository: one bare git
// repository per workspace whose top-level directories are knowledge bases.
// Everything goes through the git command line (merge-tree, commit-tree) so the
// server never needs a working tree.
package knowledge

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/pkg/errors"
)

// MainBranch 是知识库仓库的主线分支名。
const MainBranch = "main"

// BranchPrefix 是智能体和成员提交改动时允许推送的分支前缀。
const BranchPrefix = "kb/"

// MainRef 是主线的完整 ref。
const MainRef = "refs/heads/" + MainBranch

// ErrNotFound 表示请求的文件或提交不存在。
var ErrNotFound = errors.New("not found")

// ErrRefMoved 表示更新分支时它已被别人移动，调用方应重读后重试。
var ErrRefMoved = errors.New("ref moved concurrently")

var workspaceIDPattern = regexp.MustCompile(`^[0-9a-fA-F-]{36}$`)

const preReceiveHook = `#!/bin/sh
# Only kb/* branches can be pushed; main moves only through a merged change request.
while read old new ref; do
  case "$ref" in
    refs/heads/kb/*) ;;
    *) echo "only kb/* branches can be pushed; open a change request instead" >&2; exit 1 ;;
  esac
done
`

// Store 管理所有工作区的知识库仓库。
type Store struct {
	root string
	git  string

	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// Signature 是提交的作者信息。
type Signature struct {
	Name  string
	Email string
}

// FileChange 是一次提交里对单个文件的写入或删除。
type FileChange struct {
	Path    string
	Content []byte
	Delete  bool
}

// NewStore 返回以 root 为仓库根目录的 Store；root 不存在时会在首次使用时创建。
func NewStore(root string) (*Store, error) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		return nil, errors.Wrap(err, "git executable is required for the knowledge repository")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, errors.Wrapf(err, "resolve knowledge repo root %q", root)
	}

	return &Store{root: abs, git: gitPath, locks: map[string]*sync.Mutex{}}, nil
}

// Root 返回所有仓库所在的目录。
func (s *Store) Root() string { return s.root }

// RepoDir 返回工作区仓库的目录。
func (s *Store) RepoDir(workspaceID string) string {
	return filepath.Join(s.root, workspaceID+".git")
}

// lock 串行化同一工作区的写操作，ref 的比较交换仍是最终保障。
func (s *Store) lock(workspaceID string) func() {
	s.mu.Lock()
	l, ok := s.locks[workspaceID]
	if !ok {
		l = &sync.Mutex{}
		s.locks[workspaceID] = l
	}
	s.mu.Unlock()

	l.Lock()

	return l.Unlock
}

func (s *Store) run(ctx context.Context, workspaceID string, env []string, stdin io.Reader, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, s.git, args...)
	cmd.Dir = s.RepoDir(workspaceID)
	cmd.Env = append(append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C"), env...)
	cmd.Stdin = stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), &GitError{Args: args, Stderr: strings.TrimSpace(stderr.String()), Err: err}
	}

	return stdout.Bytes(), nil
}

// GitError 是一次 git 调用的失败，保留 stderr 便于定位。
type GitError struct {
	Args   []string
	Stderr string
	Err    error
}

func (e *GitError) Error() string {
	return fmt.Sprintf("git %s: %v: %s", strings.Join(e.Args, " "), e.Err, e.Stderr)
}

func (e *GitError) Unwrap() error { return e.Err }

func exitCode(err error) int {
	var ge *GitError
	if errors.As(err, &ge) {
		var ee *exec.ExitError
		if errors.As(ge.Err, &ee) {
			return ee.ExitCode()
		}
	}

	return -1
}

// Ensure 创建工作区仓库（幂等）：bare repo、主线初始提交、只允许推送 kb/* 的钩子。
func (s *Store) Ensure(ctx context.Context, workspaceID string) error {
	if !workspaceIDPattern.MatchString(workspaceID) {
		return errors.Errorf("invalid workspace id %q", workspaceID)
	}
	unlock := s.lock(workspaceID)
	defer unlock()

	dir := s.RepoDir(workspaceID)
	if _, err := os.Stat(filepath.Join(dir, "HEAD")); err == nil {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errors.Wrapf(err, "create knowledge repo dir workspace_id=%s", workspaceID)
	}

	if _, err := s.run(ctx, workspaceID, nil, nil, "init", "--bare", "--initial-branch="+MainBranch, "."); err != nil {
		return errors.WithStack(err)
	}
	if _, err := s.run(ctx, workspaceID, nil, nil, "config", "http.receivepack", "true"); err != nil {
		return errors.WithStack(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "hooks", "pre-receive"), []byte(preReceiveHook), 0o755); err != nil {
		return errors.Wrapf(err, "install pre-receive hook workspace_id=%s", workspaceID)
	}

	tree, err := s.run(ctx, workspaceID, nil, nil, "mktree")
	if err != nil {
		return errors.WithStack(err)
	}
	commit, err := s.commitTree(ctx, workspaceID, strings.TrimSpace(string(tree)), nil, "Initialize knowledge repository", systemSignature)
	if err != nil {
		return err
	}
	if _, err := s.run(ctx, workspaceID, nil, nil, "update-ref", MainRef, commit, ""); err != nil {
		return errors.WithStack(err)
	}

	return nil
}

var systemSignature = Signature{Name: "Marvis", Email: "knowledge@marvis.local"}

func signatureEnv(sig Signature) []string {
	if sig.Name == "" {
		sig = systemSignature
	}
	if sig.Email == "" {
		sig.Email = systemSignature.Email
	}

	return []string{
		"GIT_AUTHOR_NAME=" + sig.Name, "GIT_AUTHOR_EMAIL=" + sig.Email,
		"GIT_COMMITTER_NAME=" + systemSignature.Name, "GIT_COMMITTER_EMAIL=" + systemSignature.Email,
	}
}

func (s *Store) commitTree(ctx context.Context, workspaceID, tree string, parents []string, message string, sig Signature) (string, error) {
	args := []string{"commit-tree", tree}
	for _, p := range parents {
		args = append(args, "-p", p)
	}
	args = append(args, "-m", message)

	out, err := s.run(ctx, workspaceID, signatureEnv(sig), nil, args...)
	if err != nil {
		return "", errors.WithStack(err)
	}

	return strings.TrimSpace(string(out)), nil
}

// Resolve 返回 ref 指向的提交；ref 不存在时返回 ErrNotFound。
func (s *Store) Resolve(ctx context.Context, workspaceID, ref string) (string, error) {
	out, err := s.run(ctx, workspaceID, nil, nil, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		if exitCode(err) == 1 {
			return "", ErrNotFound
		}

		return "", errors.WithStack(err)
	}

	return strings.TrimSpace(string(out)), nil
}

// Head 返回主线当前提交。
func (s *Store) Head(ctx context.Context, workspaceID string) (string, error) {
	return s.Resolve(ctx, workspaceID, MainRef)
}

// BranchRef 把分支名转成完整 ref。
func BranchRef(branch string) string { return "refs/heads/" + branch }

// Commit 在 parent 的基础上应用 changes，生成提交并把 ref 从 expectOld 移到新提交。
// expectOld 为空表示 ref 必须尚不存在。
func (s *Store) Commit(ctx context.Context, workspaceID, ref, parent, expectOld, message string, sig Signature, changes []FileChange) (string, error) {
	unlock := s.lock(workspaceID)
	defer unlock()

	commit, err := s.buildCommit(ctx, workspaceID, parent, message, sig, changes)
	if err != nil {
		return "", err
	}
	if err := s.updateRef(ctx, workspaceID, ref, commit, expectOld); err != nil {
		return "", err
	}

	return commit, nil
}

func (s *Store) updateRef(ctx context.Context, workspaceID, ref, newValue, oldValue string) error {
	if _, err := s.run(ctx, workspaceID, nil, nil, "update-ref", ref, newValue, oldValue); err != nil {
		if strings.Contains(err.Error(), "cannot lock ref") || strings.Contains(err.Error(), "but expected") || strings.Contains(err.Error(), "already exists") {
			return ErrRefMoved
		}

		return errors.WithStack(err)
	}

	return nil
}

func (s *Store) buildCommit(ctx context.Context, workspaceID, parent, message string, sig Signature, changes []FileChange) (string, error) {
	tmp, err := os.MkdirTemp("", "kb-index-")
	if err != nil {
		return "", errors.WithStack(err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	env := []string{"GIT_INDEX_FILE=" + filepath.Join(tmp, "index")}

	if parent != "" {
		if _, err := s.run(ctx, workspaceID, env, nil, "read-tree", parent); err != nil {
			return "", errors.WithStack(err)
		}
	}

	// 先把所有新内容写成临时文件，一次 hash-object 写入对象库，一次 update-index 更新索引。
	var writes []FileChange
	var removes []string
	for _, c := range changes {
		if err := validatePath(c.Path); err != nil {
			return "", err
		}
		if c.Delete {
			removes = append(removes, c.Path)
		} else {
			writes = append(writes, c)
		}
	}

	var indexInfo bytes.Buffer
	if len(writes) > 0 {
		var paths bytes.Buffer
		for i, c := range writes {
			p := filepath.Join(tmp, fmt.Sprintf("blob-%d", i))
			if err := os.WriteFile(p, c.Content, 0o600); err != nil {
				return "", errors.WithStack(err)
			}
			paths.WriteString(p + "\n")
		}
		out, err := s.run(ctx, workspaceID, env, &paths, "hash-object", "-w", "--stdin-paths", "--no-filters")
		if err != nil {
			return "", errors.WithStack(err)
		}
		shas := strings.Fields(string(out))
		if len(shas) != len(writes) {
			return "", errors.Errorf("hash-object returned %d ids for %d files", len(shas), len(writes))
		}
		for i, c := range writes {
			fmt.Fprintf(&indexInfo, "100644 %s\t%s\n", shas[i], c.Path)
		}
	}
	for _, p := range removes {
		fmt.Fprintf(&indexInfo, "0 %s\t%s\n", strings.Repeat("0", 40), p)
	}
	if indexInfo.Len() > 0 {
		if _, err := s.run(ctx, workspaceID, env, &indexInfo, "update-index", "--index-info"); err != nil {
			return "", errors.WithStack(err)
		}
	}

	tree, err := s.run(ctx, workspaceID, env, nil, "write-tree")
	if err != nil {
		return "", errors.WithStack(err)
	}
	var parents []string
	if parent != "" {
		parents = []string{parent}
	}

	return s.commitTree(ctx, workspaceID, strings.TrimSpace(string(tree)), parents, message, sig)
}

func validatePath(p string) error {
	clean := filepath.ToSlash(filepath.Clean(p))
	if p == "" || clean != p || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "../") || p == ".." || strings.Contains(p, "\n") || strings.Contains(p, "\t") {
		return errors.Errorf("invalid repository path %q", p)
	}

	return nil
}

// ListFiles 列出 commit 中 prefix 目录下的所有文件路径（相对仓库根）。
func (s *Store) ListFiles(ctx context.Context, workspaceID, commit, prefix string) ([]string, error) {
	args := []string{"ls-tree", "-r", "--name-only", "-z", commit}
	if prefix != "" {
		args = append(args, "--", strings.TrimSuffix(prefix, "/")+"/")
	}
	out, err := s.run(ctx, workspaceID, nil, nil, args...)
	if err != nil {
		return nil, errors.WithStack(err)
	}

	var files []string
	for _, f := range strings.Split(string(out), "\x00") {
		if f != "" {
			files = append(files, f)
		}
	}

	return files, nil
}

// ReadFile 读取 commit 中的单个文件。
func (s *Store) ReadFile(ctx context.Context, workspaceID, commit, path string) ([]byte, error) {
	if err := validatePath(path); err != nil {
		return nil, err
	}
	out, err := s.run(ctx, workspaceID, nil, nil, "cat-file", "blob", commit+":"+path)
	if err != nil {
		if exitCode(err) == 128 {
			return nil, ErrNotFound
		}

		return nil, errors.WithStack(err)
	}

	return out, nil
}

// ReadFiles 一次读取 commit 中的多个文件，避免逐个启动 git。缺失的路径不出现在结果里。
func (s *Store) ReadFiles(ctx context.Context, workspaceID, commit string, paths []string) (map[string][]byte, error) {
	if len(paths) == 0 {
		return map[string][]byte{}, nil
	}
	var in bytes.Buffer
	for _, p := range paths {
		in.WriteString(commit + ":" + p + "\n")
	}
	out, err := s.run(ctx, workspaceID, nil, &in, "cat-file", "--batch")
	if err != nil {
		return nil, errors.WithStack(err)
	}

	result := make(map[string][]byte, len(paths))
	r := bufio.NewReader(bytes.NewReader(out))
	for _, p := range paths {
		header, err := r.ReadString('\n')
		if err != nil {
			return nil, errors.Wrapf(err, "read cat-file header path=%q", p)
		}
		fields := strings.Fields(header)
		if len(fields) == 2 && fields[1] == "missing" {
			continue
		}
		if len(fields) != 3 {
			return nil, errors.Errorf("unexpected cat-file header %q", header)
		}
		var size int
		if _, err := fmt.Sscanf(fields[2], "%d", &size); err != nil {
			return nil, errors.Wrapf(err, "parse cat-file size %q", fields[2])
		}
		buf := make([]byte, size+1)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, errors.Wrapf(err, "read cat-file body path=%q", p)
		}
		result[p] = buf[:size]
	}

	return result, nil
}

// MergeResult 是把分支合入主线的预演结果。
type MergeResult struct {
	Tree      string
	Conflicts []string
}

// TryMerge 预演把 branch 合入主线，返回合并后的 tree 或冲突文件。
func (s *Store) TryMerge(ctx context.Context, workspaceID, mainCommit, branchCommit string) (MergeResult, error) {
	return s.mergeTree(ctx, workspaceID, nil, mainCommit, branchCommit)
}

func (s *Store) mergeTree(ctx context.Context, workspaceID string, extra []string, ours, theirs string) (MergeResult, error) {
	args := append([]string{"merge-tree", "--write-tree", "--name-only", "--no-messages"}, extra...)
	args = append(args, ours, theirs)
	out, err := s.run(ctx, workspaceID, nil, nil, args...)
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if err != nil {
		if exitCode(err) == 1 && len(lines) > 0 {
			var conflicts []string
			seen := map[string]bool{}
			for _, l := range lines[1:] {
				if l != "" && !seen[l] {
					seen[l] = true
					conflicts = append(conflicts, l)
				}
			}

			return MergeResult{Tree: lines[0], Conflicts: conflicts}, nil
		}

		return MergeResult{}, errors.WithStack(err)
	}

	return MergeResult{Tree: lines[0]}, nil
}

// Merge 把 branchCommit 合入主线；有冲突时不改动主线并返回冲突文件。
func (s *Store) Merge(ctx context.Context, workspaceID, branchCommit, message string, sig Signature) (string, []string, error) {
	unlock := s.lock(workspaceID)
	defer unlock()

	head, err := s.Head(ctx, workspaceID)
	if err != nil {
		return "", nil, err
	}
	res, err := s.mergeTree(ctx, workspaceID, nil, head, branchCommit)
	if err != nil {
		return "", nil, err
	}
	if len(res.Conflicts) > 0 {
		return "", res.Conflicts, nil
	}

	commit, err := s.commitTree(ctx, workspaceID, res.Tree, []string{head, branchCommit}, message, sig)
	if err != nil {
		return "", nil, err
	}
	if err := s.updateRef(ctx, workspaceID, MainRef, commit, head); err != nil {
		return "", nil, err
	}

	return commit, nil, nil
}

// Revert 在新分支上撤销一次已合并的提交（相对它的第一个父提交），基于当前主线。
func (s *Store) Revert(ctx context.Context, workspaceID, mergedCommit, branch, message string, sig Signature) (string, []string, error) {
	unlock := s.lock(workspaceID)
	defer unlock()

	head, err := s.Head(ctx, workspaceID)
	if err != nil {
		return "", nil, err
	}
	res, err := s.mergeTree(ctx, workspaceID, []string{"--merge-base=" + mergedCommit}, head, mergedCommit+"^1")
	if err != nil {
		return "", nil, err
	}
	if len(res.Conflicts) > 0 {
		return "", res.Conflicts, nil
	}
	commit, err := s.commitTree(ctx, workspaceID, res.Tree, []string{head}, message, sig)
	if err != nil {
		return "", nil, err
	}
	if err := s.updateRef(ctx, workspaceID, BranchRef(branch), commit, ""); err != nil {
		return "", nil, err
	}

	return commit, nil, nil
}

// MergeBase 返回两个提交的共同祖先。
func (s *Store) MergeBase(ctx context.Context, workspaceID, a, b string) (string, error) {
	out, err := s.run(ctx, workspaceID, nil, nil, "merge-base", a, b)
	if err != nil {
		return "", errors.WithStack(err)
	}

	return strings.TrimSpace(string(out)), nil
}

// DeleteBranch 删除分支，分支不存在时不报错。
func (s *Store) DeleteBranch(ctx context.Context, workspaceID, branch string) error {
	if _, err := s.run(ctx, workspaceID, nil, nil, "update-ref", "-d", BranchRef(branch)); err != nil {
		if strings.Contains(err.Error(), "not exist") || strings.Contains(err.Error(), "unable to resolve") {
			return nil
		}

		return errors.WithStack(err)
	}

	return nil
}

// Archive 把主线上 prefix 目录打包成 zip 写入 w。
func (s *Store) Archive(ctx context.Context, workspaceID, commit, prefix string, w io.Writer) error {
	cmd := exec.CommandContext(ctx, s.git, "archive", "--format=zip", commit, strings.TrimSuffix(prefix, "/")+"/")
	cmd.Dir = s.RepoDir(workspaceID)
	cmd.Stdout = w
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return errors.Wrapf(err, "git archive prefix=%q: %s", prefix, stderr.String())
	}

	return nil
}
