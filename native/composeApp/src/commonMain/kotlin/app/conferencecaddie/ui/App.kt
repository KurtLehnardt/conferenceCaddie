package app.conferencecaddie.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.BackendUrl

/** The bottom-bar destinations. People is shown only when the backend's capabilities enable it. */
enum class Tab(val label: String, val icon: ImageVector) {
    ForYou("For you", Icons.Filled.Star),
    Search("Search", Icons.Filled.Search),
    Interested("Interested", Icons.Filled.Favorite),
    People("People", Icons.Filled.Person),
    Settings("Settings", Icons.Filled.Settings),
}

/** The tabs a backend with [capabilities] gets, in bottom-bar order. */
fun visibleTabs(capabilities: Capabilities): List<Tab> =
    Tab.entries.filter { it != Tab.People || capabilities.people.enabled }

/**
 * The root of the UI on both platforms. [initialCapabilities] stands in for the document fetched
 * from the backend until the capabilities client exists (Phase 1). [isDebugBuild] comes from the
 * platform entry point; debug builds accept plain http to a local server and show developer
 * controls.
 */
@Composable
fun App(
    initialCapabilities: Capabilities = Capabilities.Demo,
    initialServerUrl: String = "",
    isDebugBuild: Boolean = false,
) {
    var capabilities by remember { mutableStateOf(initialCapabilities) }
    var serverUrl by rememberSaveable { mutableStateOf(initialServerUrl) }
    var selected by rememberSaveable { mutableStateOf(Tab.ForYou) }

    val tabs = visibleTabs(capabilities)
    // If People disappears while selected (the backend changed), fall back to the first tab.
    LaunchedEffect(tabs) {
        if (selected !in tabs) selected = tabs.first()
    }

    MaterialTheme {
        Scaffold(
            bottomBar = {
                NavigationBar {
                    tabs.forEach { tab ->
                        NavigationBarItem(
                            selected = tab == selected,
                            onClick = { selected = tab },
                            icon = { Icon(tab.icon, contentDescription = null) },
                            label = { Text(tab.label) },
                        )
                    }
                }
            },
        ) { padding ->
            val modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)
            when (selected) {
                Tab.ForYou -> Placeholder("For you", "Talks picked for you will appear here.", modifier)
                Tab.Search -> Placeholder("Search", "Search the schedule by keyword or topic.", modifier)
                Tab.Interested -> Placeholder("Interested", "Talks you mark as interesting are kept here.", modifier)
                Tab.People -> Placeholder("People", "People who have built what you are looking for.", modifier)
                Tab.Settings -> SettingsScreen(
                    serverUrl = serverUrl,
                    onServerUrlSaved = { serverUrl = it },
                    capabilities = capabilities,
                    onCapabilitiesChanged = { capabilities = it },
                    isDebugBuild = isDebugBuild,
                    modifier = modifier,
                )
            }
        }
    }
}

@Composable
private fun Placeholder(title: String, body: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.headlineMedium)
        Text(body, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun SettingsScreen(
    serverUrl: String,
    onServerUrlSaved: (String) -> Unit,
    capabilities: Capabilities,
    onCapabilitiesChanged: (Capabilities) -> Unit,
    isDebugBuild: Boolean,
    modifier: Modifier = Modifier,
) {
    var draft by rememberSaveable(serverUrl) { mutableStateOf(serverUrl) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineMedium)

        OutlinedTextField(
            value = draft,
            onValueChange = {
                draft = it
                error = null
            },
            label = { Text("Server URL") },
            placeholder = { Text("https://caddie.example.org") },
            singleLine = true,
            isError = error != null,
            supportingText = {
                Text(error ?: if (serverUrl.isEmpty()) "Not set" else "Using $serverUrl")
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Button(onClick = {
            when (val result = BackendUrl.normalise(draft, allowLocalHttp = isDebugBuild)) {
                is BackendUrl.Valid -> {
                    draft = result.base
                    onServerUrlSaved(result.base)
                }
                is BackendUrl.Invalid -> error = result.reason.message(isDebugBuild)
            }
        }) {
            Text("Save")
        }

        Text("Backend tier: ${capabilities.tier.name}", style = MaterialTheme.typography.bodyMedium)

        // Until the app fetches capabilities from the backend, this switch previews the gating.
        // It is a developer control, so release builds do not show it.
        if (isDebugBuild) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Switch(
                    checked = capabilities.people.enabled,
                    onCheckedChange = { enabled ->
                        onCapabilitiesChanged(if (enabled) Capabilities.Legacy else Capabilities.Demo)
                    },
                )
                Text("Preview people features", style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

private fun BackendUrl.Reason.message(isDebugBuild: Boolean): String = when (this) {
    BackendUrl.Reason.NotAUrl -> "Enter a full address that starts with https://."
    BackendUrl.Reason.HttpsRequired ->
        if (isDebugBuild) {
            "Use https. Plain http works only for localhost, 127.0.0.1, [::1] and 10.0.2.2."
        } else {
            "Use an https address."
        }
    BackendUrl.Reason.CredentialsNotAllowed -> "Remove the user name or password from the address."
    BackendUrl.Reason.QueryNotAllowed -> "Remove the part after ? or # from the address."
}
