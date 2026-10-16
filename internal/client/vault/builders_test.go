package vault

// spec builds compact trees for tests, like extension/test/builders.ts.
// A bookmark is b("id") (title "id", url https://id.example/); a folder is
// f("id", children...). with* helpers override fields.
type spec struct {
	guid     GUID
	folder   bool
	title    *string
	url      *string
	children []spec
}

func b(g GUID) spec                    { return spec{guid: g} }
func f(g GUID, kids ...spec) spec      { return spec{guid: g, folder: true, children: kids} }
func (s spec) withTitle(t string) spec { s.title = &t; return s }
func (s spec) withURL(u string) spec   { s.url = &u; return s }

// doc builds a document with the given specs under each root.
func doc(roots map[GUID][]spec) *Doc {
	d := NewEmpty()
	var add func(parent GUID, specs []spec)
	add = func(parent GUID, specs []spec) {
		for _, s := range specs {
			n := &Node{GUID: s.guid, Title: s.guid}
			if s.title != nil {
				n.Title = *s.title
			}
			if s.folder {
				n.Kind, n.Children = Folder, []GUID{}
			} else {
				n.Kind, n.URL = Bookmark, "https://"+s.guid+".example/"
				if s.url != nil {
					n.URL = *s.url
				}
			}
			d.Nodes[s.guid] = n
			d.Nodes[parent].Children = append(d.Nodes[parent].Children, s.guid)
			if s.folder {
				add(s.guid, s.children)
			}
		}
	}
	for _, r := range Roots {
		add(r, roots[r])
	}
	return d
}

func toolbar(specs ...spec) *Doc { return doc(map[GUID][]spec{RootToolbar: specs}) }
