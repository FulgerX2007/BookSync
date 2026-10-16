package io.booksync.android.ui.bookmarks

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.booksync.android.R
import io.booksync.android.core.NodeKind
import io.booksync.android.core.Roots
import io.booksync.android.core.VNode
import io.booksync.android.ui.common.messageFor

/** Localized titles for the four roots. */
@Composable
fun rootTitles(): (String) -> String {
    val names = mapOf(
        Roots.TOOLBAR to stringResource(R.string.root_toolbar),
        Roots.MENU to stringResource(R.string.root_menu),
        Roots.OTHER to stringResource(R.string.root_other),
        Roots.MOBILE to stringResource(R.string.root_mobile),
    )
    return { names[it] ?: it }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BookmarksScreen(
    vm: BookmarksViewModel,
    onOpenUrl: (String) -> Unit,
    onSignOut: () -> Unit,
    onLeave: () -> Unit,
    banner: @Composable () -> Unit = {},
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val titles = rootTitles()
    vm.rootTitle = titles
    val snackbar = remember { SnackbarHostState() }
    val messageText = state.message?.let { stringResource(if (it == "cannot_open") R.string.cannot_open else messageFor(it)) }
    LaunchedEffect(state.message) {
        if (messageText != null) {
            snackbar.showSnackbar(messageText)
            vm.dismissMessage()
        }
    }
    BackHandler { if (!vm.up()) onLeave() }

    Scaffold(
        topBar = { BrowserTopBar(state, vm, titles, onSignOut) },
        floatingActionButton = { state.folder?.takeIf { !state.searching }?.let { AddButton(it, vm) } },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            banner()
            when {
                state.searching -> SearchResults(state, vm, onOpenUrl)
                state.folder == null -> RootList(state, vm, titles)
                else -> FolderList(state.items, vm, onOpenUrl)
            }
        }
    }
    BrowserDialogs(state, vm)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BrowserTopBar(state: BrowserState, vm: BookmarksViewModel, titles: (String) -> String, onSignOut: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    TopAppBar(
        title = {
            if (state.searching) {
                TextField(
                    value = state.query,
                    onValueChange = vm::setQuery,
                    placeholder = { Text(stringResource(R.string.search_hint)) },
                    singleLine = true,
                    colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent),
                    modifier = Modifier.fillMaxWidth().testTag("searchField"),
                )
            } else {
                val folder = state.folder
                val title = when {
                    folder == null -> stringResource(R.string.app_name)
                    folder in Roots.ALL -> titles(folder)
                    else -> state.tree?.node(folder)?.title.orEmpty()
                }
                Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.testTag("title"))
            }
        },
        navigationIcon = {
            if (state.folder != null || state.searching) {
                IconButton(onClick = { vm.up() }, modifier = Modifier.testTag("up")) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                }
            }
        },
        actions = {
            if (state.searching) {
                IconButton(onClick = { vm.setQuery("") }) { Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.clear)) }
            } else {
                IconButton(onClick = vm::startSearch, modifier = Modifier.testTag("search")) {
                    Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.search))
                }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.more)) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text(stringResource(R.string.sign_out)) }, onClick = { menu = false; onSignOut() })
                }
            }
        },
    )
}

@Composable
private fun AddButton(parent: String, vm: BookmarksViewModel) {
    var menu by remember { mutableStateOf(false) }
    Box {
        FloatingActionButton(onClick = { menu = true }, modifier = Modifier.testTag("add")) {
            Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.add))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.add_bookmark)) }, onClick = { menu = false; vm.show(BrowserDialog.AddBookmark(parent)) })
            DropdownMenuItem(text = { Text(stringResource(R.string.add_folder)) }, onClick = { menu = false; vm.show(BrowserDialog.AddFolder(parent)) })
        }
    }
}

@Composable
private fun RootList(state: BrowserState, vm: BookmarksViewModel, titles: (String) -> String) {
    LazyColumn(Modifier.fillMaxSize()) {
        items(Roots.ALL, key = { it }) { root ->
            val count = state.tree?.node(root)?.children?.size ?: 0
            ListItem(
                headlineContent = { Text(titles(root)) },
                supportingContent = { Text(pluralItems(count)) },
                leadingContent = { Icon(painterResource(R.drawable.ic_folder), contentDescription = null) },
                modifier = Modifier.combinedClickableRow(onClick = { vm.open(root) }, onLongClick = {}).testTag("row-$root"),
            )
        }
    }
}

@Composable
private fun pluralItems(n: Int): String = androidx.compose.ui.res.pluralStringResource(R.plurals.items, n, n)

@Composable
private fun FolderList(items: List<VNode>, vm: BookmarksViewModel, onOpenUrl: (String) -> Unit) {
    if (items.isEmpty()) {
        Text(stringResource(R.string.empty_folder), modifier = Modifier.padding(24.dp), style = MaterialTheme.typography.bodyMedium)
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(items, key = { it.guid }) { node -> NodeRow(node, vm, onOpenUrl) }
    }
}

@Composable
private fun NodeRow(node: VNode, vm: BookmarksViewModel, onOpenUrl: (String) -> Unit, path: List<String> = emptyList()) {
    val folder = node.kind == NodeKind.FOLDER
    ListItem(
        headlineContent = { Text(node.title.ifEmpty { node.url.orEmpty() }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            val sub = buildList {
                if (path.isNotEmpty()) add(path.joinToString(" › "))
                if (!folder) add(BookmarksViewModel.displayHost(node.url))
            }.filter { it.isNotEmpty() }.joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        leadingContent = { Icon(painterResource(if (folder) R.drawable.ic_folder else R.drawable.ic_bookmark), contentDescription = null) },
        modifier = Modifier.combinedClickableRow(
            onClick = { if (folder) vm.open(node.guid) else vm.urlToOpen(node.url)?.let(onOpenUrl) },
            onLongClick = { vm.showActions(node) },
        ).testTag("row-${node.guid}"),
    )
}

@Composable
private fun SearchResults(state: BrowserState, vm: BookmarksViewModel, onOpenUrl: (String) -> Unit) {
    if (state.query.isNotBlank() && state.results.isEmpty()) {
        Text(stringResource(R.string.no_results), modifier = Modifier.padding(24.dp))
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(state.results, key = { it.guid }) { r ->
            val node = state.tree?.node(r.guid) ?: return@items
            ListItem(
                headlineContent = { Text(r.title.ifEmpty { r.url.orEmpty() }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                supportingContent = {
                    Text(
                        (listOf(r.path.joinToString(" › ")) + listOfNotNull(r.url?.let(BookmarksViewModel::displayHost))).filter { it.isNotEmpty() }.joinToString(" · "),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                leadingContent = { Icon(painterResource(if (r.kind == NodeKind.FOLDER) R.drawable.ic_folder else R.drawable.ic_bookmark), contentDescription = null) },
                modifier = Modifier.combinedClickableRow(
                    onClick = { vm.openResult(r)?.let(onOpenUrl) },
                    onLongClick = { vm.showActions(node) },
                ).testTag("result-${r.guid}"),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableRow(onClick: () -> Unit, onLongClick: () -> Unit) =
    combinedClickable(onClick = onClick, onLongClick = onLongClick)
